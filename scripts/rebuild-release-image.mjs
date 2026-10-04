// Release assets -> verified SQL payload -> candidate image. Never reads Actions artifacts.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { batch, pipelineProducer, repository } from './candidate-pipeline.mjs';
import { baseImage } from './candidate-bundle-image.mjs';
import { composeReleaseContext, releaseTargets } from './compose-release-set.mjs';
import { releaseTag, validateAssembled } from './release-set-image.mjs';
import { fileHash, sha256, writeJson } from './collection-checkpoints.mjs';
import { localDockerOnly } from './load-occurrence-staging.mjs';

const execute = promisify(execFile);
const run = async (program, args) => (await execute(program, args, { maxBuffer: 16 * 1024 ** 2, timeout: 180000 })).stdout.trim();
const api = async path => JSON.parse(await run('gh', ['api', `repos/${repository}/${path}`]));
const json = async path => JSON.parse(await readFile(path));
const safeInteger = n => assert.ok(Number.isSafeInteger(n) && n > 0);
const digest = d => assert.match(d ?? '', /^sha256:[a-f0-9]{64}$/);
const hex = s => assert.match(s ?? '', /^[a-f0-9]{64}$/);
const source = p => {
  assert.match(p.commit ?? '', /^[a-f0-9]{40}$/);
  for (const n of [p.runId, p.attempt]) assert.match(String(n), /^[1-9][0-9]*$/);
};

export function validateReleaseMetadata(release, assets, tag, manifestSha256) {
  assert.match(tag, /^data-r[1-9][0-9]*-a[1-9][0-9]*$/);
  hex(manifestSha256); safeInteger(release.id);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false, 'Only published data releases can be rebuilt');
  assert.equal(release.html_url, `https://github.com/${repository}/releases/tag/${tag}`);
  assert.equal(new Set(assets.map(a => a.name)).size, assets.length);
  assert.equal(new Set(assets.map(a => a.id)).size, assets.length);
  for (const a of assets) {
    safeInteger(a.id); safeInteger(a.size); digest(a.digest);
    assert.equal(a.state, 'uploaded');
    assert.ok(a.size < 2 * 1024 ** 3);
  }
  const manifests = assets.filter(a => a.name === 'data-manifest.json');
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].digest, `sha256:${manifestSha256}`);
  assert.ok(manifests[0].size <= 2 * 1024 ** 2);
  return manifests[0];
}

export function selectReleaseSQL(manifest, assets, tag) {
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.repository, repository);
  assert.equal(manifest.tag, tag); source(manifest.producer);
  assert.equal(tag, `data-r${manifest.producer.runId}-a${manifest.producer.attempt}`);
  assert.match(manifest.archiveCommit, /^[a-f0-9]{40}$/);
  hex(manifest.image.identity); hex(manifest.image.catalogSha256);
  assert.match(manifest.image.reference, /^kishikawakatsumi\/applelocalization-data@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manifest.datasets.map(d => d.id), releaseTargets());
  assert.equal(new Set(manifest.artifacts.map(a => a.id)).size, manifest.artifacts.length);
  assert.equal(new Set(manifest.artifacts.map(a => a.name)).size, manifest.artifacts.length);
  for (const a of manifest.artifacts) {
    assert.match(a.name, /^[a-z0-9][a-z0-9_-]*$/); safeInteger(a.id); source(a); digest(a.digest);
    const matches = assets.filter(x => x.name === `${a.name}.zip`);
    assert.equal(matches.length, 1); assert.equal(matches[0].size, a.size); assert.equal(matches[0].digest, a.digest);
  }
  const expectedNames = [...manifest.artifacts.map(a => `${a.name}.zip`), 'data-manifest.json', 'SHA256SUMS'];
  assert.deepEqual(assets.map(a => a.name).sort(), expectedNames.sort());
  const entries = manifest.datasets.map(d => {
    const target = batch.targets.find(t => t.id === d.id);
    for (const key of ['platform', 'version', 'build']) assert.equal(d[key], target[key]);
    assert.deepEqual(d.components.map(({ key, schema }) => ({ key, schema })),
      batch.jobs.filter(c => c.target === d.id).map(({ key, schema }) => ({ key, schema })));
    for (const c of d.components) hex(c.packageManifest);
    const matches = manifest.artifacts.filter(a => a.name === `candidate-sql-${d.id}-${a.runId}-${a.attempt}`);
    assert.equal(matches.length, 1, `Exactly one SQL bundle required for ${d.id}`);
    return { dataset: d, pin: matches[0], asset: assets.find(a => a.name === `${matches[0].name}.zip`) };
  });
  const receiptName = `unified-candidate-receipts-${manifest.producer.runId}-${manifest.producer.attempt}`;
  const receipts = manifest.artifacts.filter(a => a.name === receiptName);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].commit, manifest.producer.commit);
  return { entries, receipt: assets.find(a => a.name === `${receiptName}.zip`) };
}

export function validateOriginalCatalog(manifest, catalog, pushed) {
  assert.equal(pushed.digest, manifest.image.reference);
  assert.equal(pushed.identity, manifest.image.identity);
  assert.equal(pushed.catalogSha256, manifest.image.catalogSha256);
  assert.deepEqual(pushed.producer, manifest.producer);
  assert.equal(catalog.allPlannedTargets, true); assert.deepEqual(catalog.missingTargets, []);
  assert.equal(catalog.database, 'localization_staging');
  assert.equal(catalog.searchScope, 'one-platform-major-version');
  assert.deepEqual(catalog.datasets, manifest.datasets);
  assert.equal(sha256(JSON.stringify(catalog)), manifest.image.identity);
  assert.equal(sha256(JSON.stringify(catalog, null, 2) + '\n'), manifest.image.catalogSha256);
  assert.deepEqual(catalog.inputs.map(p => p.target), releaseTargets());
  for (const p of catalog.inputs) hex(p.bundleSha256);
}

export function sqlZipFiles(dataset) {
  return ['bundle.json', ...dataset.components.flatMap(c => {
    assert.match(c.key, /^[a-z0-9][a-z0-9_-]*$/);
    return ['import.sql.gz', 'report.json', 'verification.json'].map(file => `${c.key}/${file}`);
  })];
}

async function download(asset, file) {
  const child = spawn('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'],
    { stdio: ['ignore', 'pipe', 'inherit'], timeout: 15 * 60 * 1000 });
  const done = new Promise((ok, fail) => {
    child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(Error('Release asset download failed')));
  });
  try { await Promise.all([pipeline(child.stdout, createWriteStream(file, { flags: 'wx' })), done]); }
  catch (error) { child.kill(); throw error; }
  assert.equal((await stat(file)).size, asset.size);
  assert.equal(`sha256:${await fileHash(file)}`, asset.digest, `Asset hash mismatch: ${asset.name}`);
}
async function unpack(file, output, files) {
  await run('python3', [fileURLToPath(new URL('./unpack-release-sql.py', import.meta.url)),
    '--archive', file, '--output', output, '--files', JSON.stringify(files)]);
}
async function stream(program, args) {
  const child = spawn(program, args, { stdio: 'inherit' });
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok); });
  assert.equal(code, 0, `${program} failed`);
}

export async function rebuild({ tag, manifestSha256, output }) {
  const producer = pipelineProducer();
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); localDockerOnly();
  assert.match(tag, /^data-r[1-9][0-9]*-a[1-9][0-9]*$/); hex(manifestSha256);
  output = resolve(output); await mkdir(output); // fresh directory; never overwrite a previous attempt
  const release = await api(`releases/tags/${tag}`);
  const assets = JSON.parse(await run('gh', ['api', '--paginate', '--slurp',
    `repos/${repository}/releases/${release.id}/assets?per_page=100`])).flat();
  const asset = validateReleaseMetadata(release, assets, tag, manifestSha256);
  await download(asset, join(output, 'data-manifest.json'));
  const manifest = await json(join(output, 'data-manifest.json'));
  const { entries, receipt } = selectReleaseSQL(manifest, assets, tag);
  assert.equal((await api(`commits/${tag}`)).sha, manifest.archiveCommit);
  const dockerRoot = await run('docker', ['info', '--format', '{{.DockerRootDir}}']);
  const capacity = async (minimum) => {
    for (const path of new Set([output, dockerRoot])) {
      const s = await statfs(path);
      assert.ok(s.bavail * s.bsize >= minimum, 'Insufficient space for Release rebuild; no push');
    }
  };
  await capacity(entries.reduce((n, e) => n + e.asset.size, 0) * 3 + 10 * 1024 ** 3);
  const receiptsZip = join(output, 'receipts.zip');
  assert.ok(receipt.size < 10 * 1024 ** 2);
  await download(receipt, receiptsZip);
  // Receipt archives may include diagnostics. Read only named JSON members, with
  // a bounded stdout buffer, without extracting arbitrary receipt paths.
  const member = async name => JSON.parse(await run('unzip', ['-p', receiptsZip, name]));
  const catalog = await member('unified/context/payload/release-set.json');
  const pushed = await member('unified/pushed.json');
  validateOriginalCatalog(manifest, catalog, pushed);
  const inputs = [];
  for (const e of entries) {
    const zip = join(output, `${e.dataset.id}.zip`), sql = join(output, e.dataset.id);
    await download(e.asset, zip);
    await unpack(zip, sql, sqlZipFiles(e.dataset));
    await rm(zip);
    const bundle = await json(join(sql, 'bundle.json'));
    assert.deepEqual(bundle.producer, { commit: e.pin.commit, runId: String(e.pin.runId), attempt: String(e.pin.attempt) });
    const pin = catalog.inputs.find(p => p.target === e.dataset.id);
    assert.equal(await fileHash(join(sql, 'bundle.json')), pin.bundleSha256);
    inputs.push({ target: e.dataset.id, sql, bundleSha256: pin.bundleSha256 });
    console.log(`Verified Release SQL: ${e.dataset.id}`);
  }
  const inputReceipt = { formatVersion: 1, status: 'release-sql-downloaded-hash-verified',
    source: 'github-release-assets-only', releaseId: release.id, tag, manifestSha256,
    originalImage: manifest.image.reference, assets: entries.map(e => ({ id: e.asset.id, name: e.asset.name, digest: e.asset.digest })),
    producer, actionsArtifactsUsed: false, originalImagesDownloaded: false };
  await writeJson(join(output, 'release-input.json'), inputReceipt);
  const composed = await composeReleaseContext({ inputs, output: join(output, 'assembled') });
  assert.deepEqual(composed.catalog, catalog, 'Rebuilt catalog differs from retained data');
  assert.equal(composed.identity, manifest.image.identity);
  assert.equal(await fileHash(join(composed.context, 'payload/release-set.json')), manifest.image.catalogSha256);
  const imageTag = releaseTag(producer), localTag = `applelocalization-data-candidate:${imageTag}`;
  assert.ok(!(await run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n').includes(localTag));
  await stream('docker', ['pull', '--platform=linux/amd64', baseImage]);
  await stream('docker', ['build', '--pull=false', '--network=none', '--platform=linux/amd64', '--provenance=false', '--load',
    '--build-arg', `BASE_IMAGE=${baseImage}`, '--label', `org.applelocalization.bundle=${composed.identity}`, '--tag', localTag, composed.context]);
  const [built] = JSON.parse(await run('docker', ['image', 'inspect', localTag]));
  assert.equal(built.Config.Labels['org.applelocalization.bundle'], composed.identity);
  await stream('docker', ['run', '--rm', '--network=none', '--entrypoint', '/bin/sh', localTag, '-ec',
    'cd /opt/localization && sha256sum -c SHA256SUMS && postgres --version']);
  await capacity(5 * 1024 ** 3);
  const result = { status: 'unified-candidate-assembled-restore-pending', producer, tag: imageTag, localTag,
    image: built.Id, identity: composed.identity, baseImage,
    planSha256: await fileHash(join(output, 'release-input.json')),
    catalog: composed.catalog, catalogSha256: manifest.image.catalogSha256,
    components: catalog.datasets.flatMap(d => d.components).length, imageBytes: built.Size,
    releaseInput: inputReceipt, imagePayloadHashesVerified: true,
    priorPerVersionFullAuditReused: true, unifiedRestoreVerified: false,
    cleanRestartVerified: false, countsAndSearchVerified: false,
    apiCompatible: false, productionReady: false, productionDeployed: false };
  validateAssembled(result, producer);
  await writeJson(join(output, 'assembled.json'), result);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `assembled_sha256=${await fileHash(join(output, 'assembled.json'))}\n`);
  console.log(JSON.stringify({ status: result.status, localTag, identity: composed.identity, actionsArtifactsUsed: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { tag: { type: 'string' }, 'manifest-sha256': { type: 'string' }, output: { type: 'string' } } });
  await rebuild({ tag: v.tag, manifestSha256: v['manifest-sha256'], output: v.output });
}
