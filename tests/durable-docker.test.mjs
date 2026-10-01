import test from "node:test";
import assert from "node:assert/strict";
import {
  assertOwnedRestoreContainer,
  compareRestoreSearch,
  rehearseDurableDocker,
  restoreIdentity,
} from "../scripts/rehearse-durable-docker.mjs";

test("restore cleanup refuses another container, run, image, network or volume", () => {
  const identity = restoreIdentity(
    "applelocalization-restore-test",
    "sha256:" + "a".repeat(64),
  );
  const container = {
    Name: "/" + identity.name,
    Image: identity.image,
    Config: {
      Labels: {
        "org.applelocalization.rehearsal": "durable-sql-restore-rehearsal",
        "org.applelocalization.rehearsal-nonce": "nonce",
      },
    },
    HostConfig: { NetworkMode: "none" },
    Mounts: [{
      Type: "volume",
      Name: identity.volume,
      Destination: "/var/lib/postgresql/data",
    }],
  };
  assert.doesNotThrow(() =>
    assertOwnedRestoreContainer(container, identity, "nonce")
  );
  for (
    const mutate of [
      (c) => {
        c.Name = "/production";
      },
      (c) => {
        c.Image = "different";
      },
      (c) => {
        c.Config.Labels["org.applelocalization.rehearsal-nonce"] = "other-run";
      },
      (c) => {
        c.HostConfig.NetworkMode = "host";
      },
      (c) => {
        c.Mounts[0].Name = "production";
      },
      (c) => {
        c.Mounts[0].Type = "bind";
      },
      (c) => {
        c.Mounts.push({ ...c.Mounts[0] });
      },
    ]
  ) {
    const other = structuredClone(container);
    mutate(other);
    assert.throws(() => assertOwnedRestoreContainer(other, identity, "nonce"));
  }
});

test("restore identity requires a new isolated namespace and immutable cached image ID", () => {
  const image = "sha256:" + "a".repeat(64);
  assert.deepEqual(
    restoreIdentity("applelocalization-restore-ios261-001", image),
    {
      name: "applelocalization-restore-ios261-001",
      volume: "applelocalization-restore-ios261-001-data",
      image,
    },
  );
  for (
    const name of [
      "applelocalization-staging-ios26-20260928",
      "production",
      "applelocalization-restore-../x",
      "",
    ]
  ) {
    assert.throws(() => restoreIdentity(name, image));
  }
  for (
    const tag of [
      "groonga/pgroonga:latest",
      "groonga/pgroonga:4.0.4-alpine-16-slim",
      "sha256:no",
    ]
  ) {
    assert.throws(() => restoreIdentity("applelocalization-restore-test", tag));
  }
});

test("restore comparison checks every matching ID digest, language evidence and contextual variants", () => {
  const baseline = {
    status: "occurrence-search-verified",
    schema: "localization_fixture",
    packageManifest: "manifest",
    conditionPolicy: "strict",
    languageProfiles: [{ id: 1, code: "ja", exact_found: true }],
    profilesWithSample: 1,
    variants: [{ target_text: "開く", rows: "2", bundles: "2" }],
    measurements: [{
      language: "ja",
      term: "設定",
      matches: "2",
      idsSha256: "hash",
      pageRows: 2,
      matchingIdsAgree: true,
      pagesAgree: true,
      indexMilliseconds: 12,
    }],
  };
  const restored = structuredClone(baseline);
  restored.measurements[0].indexMilliseconds = 30; // Runtime is not a correctness requirement.
  assert.equal(compareRestoreSearch(baseline, restored).cases, 1);
  for (
    const mutate of [
      (r) => {
        r.packageManifest = "wrong";
      },
      (r) => {
        r.schema = "public";
      },
      (r) => {
        r.measurements[0].idsSha256 = "different";
      },
      (r) => {
        r.measurements[0].matches = "3";
      },
      (r) => {
        r.measurements[0].pagesAgree = false;
      },
      (r) => {
        r.measurements = [];
      },
      (r) => {
        r.variants[0].bundles = "1";
      },
      (r) => {
        r.languageProfiles[0].code = "en";
      },
      (r) => {
        r.status = "running";
      },
      (r) => {
        r.conditionPolicy = "relaxed";
      },
    ]
  ) {
    const changed = structuredClone(restored);
    mutate(changed);
    assert.throws(() => compareRestoreSearch(baseline, changed));
  }
});

test("restore does not inspect or mutate Docker without explicit local write approval", async () => {
  await assert.rejects(
    rehearseDurableDocker({}),
    /Explicit local restore write approval/,
  );
});
