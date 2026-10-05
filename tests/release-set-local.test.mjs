import test from "node:test";
import assert from "node:assert/strict";
import { batch } from "../scripts/candidate-pipeline.mjs";
import { baseImage } from "../scripts/candidate-bundle-image.mjs";
import {
  releaseCatalog,
  releaseTargets,
} from "../scripts/compose-release-set.mjs";
import {
  releaseTag,
  validateAssembled,
  validateVerified,
} from "../scripts/release-set-image.mjs";
import { sha256 } from "../scripts/collection-checkpoints.mjs";
import {
  requireLocalCapacity,
  validateLocalContainer,
  validateLocalReceipt,
  verifyLocalRelease,
} from "../scripts/verify-release-set-local.mjs";

function fixture() {
  const bundles = releaseTargets().map((id) => ({
    formatVersion: 1,
    status: "candidate-sql-bundle-verified",
    target: batch.targets.find((t) => t.id === id),
    components: batch.jobs.filter((c) => c.target === id).map((c) => ({
      ...c,
      packageManifest: "b".repeat(64),
      sqlSha256: "c".repeat(64),
      sqlReportSha256: "d".repeat(64),
    })),
    apiCompatible: false,
    productionReady: false,
    published: false,
  }));
  const catalog = { ...releaseCatalog(bundles), inputs: [] },
    producer = { runId: "1234", attempt: "1", commit: "a".repeat(40) },
    tag = releaseTag(producer);
  const assembled = {
    status: "unified-candidate-assembled-restore-pending",
    producer,
    tag,
    localTag: `applelocalization-data-candidate:${tag}`,
    image: "sha256:" + "1".repeat(64),
    baseImage,
    catalog,
    catalogSha256: sha256(JSON.stringify(catalog, null, 2) + "\n"),
    identity: sha256(JSON.stringify(catalog)),
    components: batch.jobs.length,
    priorPerVersionFullAuditReused: true,
    unifiedRestoreVerified: false,
    cleanRestartVerified: false,
    countsAndSearchVerified: false,
    apiCompatible: false,
    productionReady: false,
    productionDeployed: false,
  };
  const pushed = {
    status: "unified-candidate-pushed-restore-pending",
    producer,
    image: `docker.io/kishikawakatsumi/applelocalization-data:${tag}`,
    digest: "kishikawakatsumi/applelocalization-data@sha256:" + "2".repeat(64),
    imageId: assembled.image,
    identity: assembled.identity,
    catalogSha256: assembled.catalogSha256,
    assembledSha256: "3".repeat(64),
    unifiedRestoreVerified: false,
    productionDeployed: false,
    apiCompatible: false,
  };
  return { assembled, pushed };
}
test("assembled candidates remain distinct from restored or production-ready images", () => {
  const { assembled, pushed } = fixture();
  validateAssembled(assembled, assembled.producer);
  validateLocalReceipt(pushed, assembled);
  assert.throws(() => validateVerified(assembled, assembled.producer));
  for (
    const mutate of [
      (d) => d.unifiedRestoreVerified = true,
      (d) => d.cleanRestartVerified = true,
      (d) => d.productionReady = true,
      (d) => d.countsAndSearchVerified = true,
      (d) => d.catalog.datasets.pop(),
      (d) => d.identity = "0".repeat(64),
      (d) => d.catalogSha256 = "0".repeat(64),
      (d) => d.catalog.datasets[0].components[0].schema = "public",
      (d) => d.priorPerVersionFullAuditReused = false,
    ]
  ) {
    const d = structuredClone(assembled);
    mutate(d);
    assert.throws(() => validateAssembled(d, assembled.producer));
  }
  for (
    const mutate of [
      (d) => d.digest = "kishikawakatsumi/applelocalization-data:latest",
      (d) => d.digest = "foreign/repo@sha256:" + "2".repeat(64),
      (d) =>
        d.image = "docker.io/kishikawakatsumi/applelocalization-data:latest",
      (d) => d.imageId = "sha256:" + "0".repeat(64),
      (d) => d.status = "unified-candidate-pushed-not-deployed",
      (d) => d.unifiedRestoreVerified = true,
      (d) => d.producer.runId = "999",
    ]
  ) {
    const d = structuredClone(pushed);
    mutate(d);
    assert.throws(() => validateLocalReceipt(d, assembled));
  }
});
test("local checks require explicit authority before Docker or filesystem side effects", async () => {
  await assert.rejects(verifyLocalRelease({}), /allow-local-restore/);
  await assert.rejects(
    verifyLocalRelease({ allowLocalRestore: true }),
    /allow-pull/,
  );
});
test("capacity checks protect both host and Docker VM without reducing the runtime reserve", () => {
  const g = 1024 ** 3;
  requireLocalCapacity(230 * g, 250 * g, true);
  requireLocalCapacity(11 * g, 12 * g);
  assert.throws(() => requireLocalCapacity(230 * g, 64 * g, true));
  assert.throws(() => requireLocalCapacity(64 * g, 250 * g, true));
  assert.throws(() => requireLocalCapacity(200 * g, 9 * g));
  assert.throws(() => requireLocalCapacity(9 * g, 200 * g));
});
test("local verification only controls its exact isolated container and dedicated volume", () => {
  const owned = {
    image: "sha256:" + "a".repeat(64),
    identity: "b".repeat(64),
    nonce: "nonce",
    name: "localization-local-1234-nonce",
    volume: "localization-local-1234-nonce-data",
  };
  const c = {
    Name: "/" + owned.name,
    Image: owned.image,
    Config: {
      Labels: {
        "org.applelocalization.nonce": owned.nonce,
        "org.applelocalization.bundle": owned.identity,
      },
    },
    HostConfig: { NetworkMode: "none", PortBindings: {} },
    Mounts: [{
      Type: "volume",
      Name: owned.volume,
      Destination: "/var/lib/postgresql/data",
    }],
  };
  validateLocalContainer(c, owned);
  for (
    const mutate of [
      (x) => x.Name = "/production",
      (x) => x.Image = "sha256:" + "c".repeat(64),
      (x) => x.Config.Labels["org.applelocalization.nonce"] = "foreign",
      (x) => x.HostConfig.NetworkMode = "host",
      (x) => x.HostConfig.PortBindings = { "5432/tcp": [{}] },
      (x) => x.Mounts[0].Name = "existing-db",
      (x) => x.Mounts[0].Type = "bind",
    ]
  ) {
    const x = structuredClone(c);
    mutate(x);
    assert.throws(() => validateLocalContainer(x, owned));
  }
});
