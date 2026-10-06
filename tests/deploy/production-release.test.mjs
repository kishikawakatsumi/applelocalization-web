import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  composeEnvironment,
  contextIndexMode,
  readOnlyRoleSQL,
  releasePort,
  smoke,
  validateVerification,
  validateWebReceipt,
} from "../../scripts/deploy/production-release.mjs";

test("prepared Compose environment cannot be overridden by shell variables", () => {
  const env = composeEnvironment(
    "RELEASE_DB_VOLUME=verified-volume\nRELEASE_PORT=8085\n",
    {
      PATH: "/bin",
      RELEASE_DB_VOLUME: "production-volume",
      COMPOSE_PROFILES: "unsafe",
      COMPOSE_PROJECT_NAME: "production",
      RELEASE_APP_PASSWORD_FILE: "/other-secret",
    },
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    RELEASE_DB_VOLUME: "verified-volume",
    RELEASE_PORT: "8085",
  });
  assert.throws(() => composeEnvironment("RELEASE_PORT=8085\nRELEASE_PORT=80"));
  assert.throws(() => composeEnvironment("PATH=/bin"));
});
const receipt = {
  status: "release-web-image-pushed",
  digest: "kishikawakatsumi/applelocalization-web@sha256:" + "a".repeat(64),
  commit: "b".repeat(40),
  runId: "12",
  attempt: "1",
  platform: "linux/amd64",
};
test("context policy is explicitly pinned during preparation, not a shell override", () => {
  assert.equal(contextIndexMode(), "auto");
  assert.equal(contextIndexMode("off"), "off");
  assert.throws(() => contextIndexMode("on"));
  assert.throws(() => contextIndexMode("auto\n"));
  assert.equal(
    composeEnvironment("RELEASE_CONTEXT_INDEX_MODE=off", {
      RELEASE_CONTEXT_INDEX_MODE: "auto",
    }).RELEASE_CONTEXT_INDEX_MODE,
    "off",
  );
});
test("release pins reject mutable, foreign and incomplete images", () => {
  validateWebReceipt(receipt);
  for (
    const change of [
      { digest: "kishikawakatsumi/applelocalization-web:latest" },
      { digest: receipt.digest.replace("kishikawakatsumi", "unknown") },
      { commit: "main" },
      { runId: "0" },
      { platform: "linux/arm64" },
      { status: "built" },
    ]
  ) assert.throws(() => validateWebReceipt({ ...receipt, ...change }));
});
test("loopback port and SQL inputs are bounded", () => {
  assert.equal(releasePort("8085"), 8085);
  for (const v of [80, 0, 65536, "8085\n", "8085;echo bad"]) {
    assert.throws(() => releasePort(v));
  }
  const role = "web_" + "a".repeat(24),
    password = "b".repeat(64),
    schemas = ["localization_ios27_os"];
  const sql = readOnlyRoleSQL(role, password, schemas);
  assert.match(
    sql,
    /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(sql, /GRANT SELECT ON ALL TABLES/);
  assert.match(sql, /to_regnamespace\('context_ios27_os'\)/);
  assert.match(sql, /GRANT USAGE ON SCHEMA context_ios27_os/);
  assert.doesNotMatch(
    sql,
    /GRANT ALL|GRANT INSERT|GRANT UPDATE|GRANT DELETE|ALTER DEFAULT PRIVILEGES/,
  );
  assert.throws(() => readOnlyRoleSQL("postgres", password, schemas));
  assert.throws(() => readOnlyRoleSQL(role, "'; DROP SCHEMA public;", schemas));
  assert.throws(() => readOnlyRoleSQL(role, password, ["public"]));
});
test("verification must bind restored volume, image and receipt with all gates", () => {
  const owned = {
    image: "image",
    name: "name",
    volume: "volume",
    identity: "identity",
    digest: "digest",
    receiptSha256: "receipt",
  };
  const verified = {
    ...owned,
    status: "unified-candidate-local-restore-verified-not-deployed",
    unifiedRestoreVerified: true,
    countsAndSearchVerified: true,
    cleanRestartVerified: true,
    normalAutovacuumVerified: true,
  };
  const pushed = { imageId: "image", digest: "digest", identity: "identity" };
  validateVerification(verified, owned, pushed);
  for (
    const change of [
      { volume: "old-volume" },
      { countsAndSearchVerified: false },
      { image: "other" },
      { receiptSha256: "other" },
    ]
  ) {
    assert.throws(() =>
      validateVerification({ ...verified, ...change }, owned, pushed)
    );
  }
});
test("public routing and legacy cleanup cannot be executed by release tooling", async () => {
  const workflow = await readFile(".github/workflows/release-web.yml", "utf8");
  assert.doesNotMatch(workflow, /ssh-action|prune|compose down/);
  const compose = await readFile("deploy/compose.existing.yml", "utf8");
  assert.match(compose, /external: true/);
  assert.match(compose, /127\.0\.0\.1:/);
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /RELEASE_DB_USER/);
  assert.match(compose, /localization-ready/);
  assert.doesNotMatch(compose, /latest|build:/);
  const script = await readFile("scripts/deploy/production-release.mjs", "utf8");
  assert.doesNotMatch(
    script,
    /['"]prune['"]|['"]volume['"],\s*['"]rm['"]|\['down'|['"]ssh['"]|nginx.*reload/,
  );
});
test("smoke checks production mode, nonempty search and exact OS/component scope", async () => {
  const d = {
    id: "ios27",
    platform: "iOS",
    version: "27.0.1",
    build: "24A1",
    components: [{ key: "ios27-os" }],
  };
  let wrong = false;
  const fetcher = async (url) => {
    if (url.endsWith("/healthz")) {
      return Response.json({ ready: true, validationOnly: false, datasets: 1 });
    }
    if (url.endsWith("/catalog")) return Response.json({ target: d });
    if (url.includes("/search?")) {
      return Response.json({
        total: 1,
        data: [{ dataset: d.id, component: wrong ? "macos27-os" : "ios27-os" }],
        meta: { dataset: d.id, validationOnly: false },
      });
    }
    return new Response("<html>existing UI</html>");
  };
  assert.equal(
    (await smoke("http://127.0.0.1:8085", { datasets: [d] }, fetcher)).length,
    1,
  );
  wrong = true;
  await assert.rejects(
    smoke("http://127.0.0.1:8085", { datasets: [d] }, fetcher),
  );
});
