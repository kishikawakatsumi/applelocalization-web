// Retain exact, verified Actions ZIPs in this repository. No extraction or deployment.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const repository = 'kishikawakatsumi/applelocalization-web';
const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const command = async (program, args) => (await execute(program, args, {
  maxBuffer: 16 * 1024 ** 2, timeout: 15 * 60 * 1000,
})).stdout;
const gh = (...args) => command('gh', args);
const api = async path => JSON.parse(await gh('api', `repos/${repository}/${path}`));
const pages = async (path, key) => JSON.parse(await gh('api', '--paginate', '--slurp',
  `repos/${repository}/${path}`)).flatMap(page => key ? page[key] : page);
const positive = n => assert.ok(Number.isSafeInteger(n) && n > 0);
const hex = s => assert.match(s, /^[a-f0-9]{64}$/);

export function validateRun(run, workflow, id) {
  positive(id);
  assert.equal(run.id, id);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.path, `.github/workflows/${workflow}.yml`);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  positive(run.run_attempt);
  return run;
}

export function validateArtifact(a, run, expected) {
  positive(a.id); positive(a.size_in_bytes);
  assert.equal(a.expired, false, `Expired artifact: ${a.name}`);
  assert.equal(a.workflow_run?.id, run.id);
  assert.match(a.name, /^[a-z0-9][a-z0-9_-]*$/);
  assert.match(a.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(a.size_in_bytes < 2 * 1024 ** 3, `Release asset needs splitting: ${a.name}`);
  if (expected) {
    assert.equal(a.id, expected.id);
    assert.equal(a.name, expected.name);
    assert.equal(a.digest, expected.digest);
    assert.equal(a.size_in_bytes, expected.size_in_bytes ?? expected.bytes);
  }
  return { id: a.id, name: a.name, size: a.size_in_bytes, digest: a.digest,
    runId: run.id, attempt: run.run_attempt, commit: run.head_sha };
}

export function validateLineage(plan, catalog, candidates) {
  assert.equal(catalog.allPlannedTargets, true);
  assert.deepEqual(catalog.missingTargets, []);
  assert.ok(catalog.datasets.length > 0);
  const ids = catalog.datasets.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(plan.pins.map(p => p.target).sort(), [...ids].sort());
  const components = [];
  for (const p of plan.pins) {
    const candidate = candidates.get(p.runId);
    assert.ok(candidate);
    const ready = candidate.ready.filter(x => x.target.id === p.target);
    assert.equal(ready.length, 1);
    const target = ready[0], dataset = catalog.datasets.find(d => d.id === p.target);
    assert.equal(target.target.version, dataset.version);
    assert.equal(target.target.build, dataset.build);
    assert.deepEqual(target.components.map(c => c.key).sort(), dataset.components.map(c => c.key).sort());
    for (const c of target.components) components.push({ ...c, source: candidate.source });
  }
  assert.equal(new Set(components.map(c => c.key)).size, components.length);
  assert.equal(new Set(components.map(c => c.artifact.id)).size, components.length);
  return components;
}

export function verifyAssetSet(actual, expected) {
  const compact = x => ({ name: x.name, size: x.size, digest: x.digest });
  const sort = xs => xs.map(compact).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(sort(actual), sort(expected), 'Release assets incomplete or changed; keep draft');
}

export function releaseCommit(releases, currentCommit) {
  assert.ok(releases.length <= 1);
  // The release tag identifies archival code, not an old, unreferenced workflow
  // commit. Original data producers remain separately pinned in the manifest.
  const commit = releases[0]?.target_commitish ?? currentCommit;
  assert.match(commit, /^[a-f0-9]{40}$/);
  return commit;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}
async function download(a, dir) {
  const file = join(dir, `${a.name}.zip`);
  const child = spawn('gh', ['api', `repos/${repository}/actions/artifacts/${a.id}/zip`],
    { stdio: ['ignore', 'pipe', 'inherit'], timeout: 15 * 60 * 1000 });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('Artifact download failed')));
  });
  try { await Promise.all([pipeline(child.stdout, createWriteStream(file, { flags: 'wx' })), done]); }
  catch (error) { child.kill(); throw error; }
  assert.equal((await stat(file)).size, a.size);
  assert.equal(await hashFile(file), a.digest, `Artifact SHA-256 mismatch: ${a.name}`);
  return file;
}
async function zipJSON(file, member) {
  return JSON.parse(await command('unzip', ['-p', file, member]));
}

export async function archive(unifiedId, publish) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run in Actions; no bulk local downloads');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const dir = await mkdtemp(join(tmpdir(), 'localization-release-'));
  const runs = new Map(), listings = new Map(), artifacts = new Map(), files = new Map();
  const getRun = async (id, workflow) => {
    if (!runs.has(id)) runs.set(id, await api(`actions/runs/${id}`));
    return validateRun(runs.get(id), workflow, id);
  };
  const select = async (run, name, expected) => {
    if (!listings.has(run.id)) listings.set(run.id, await pages(`actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts'));
    const found = listings.get(run.id).filter(a => a.name === name);
    assert.equal(found.length, 1, `Missing or ambiguous artifact: ${name}`);
    const a = validateArtifact(found[0], run, expected);
    artifacts.set(a.id, a);
    return a;
  };
  const metadata = async a => {
    assert.ok(a.size < 10 * 1024 ** 2, 'Unexpectedly large receipt');
    const file = await download(a, dir); files.set(a.id, file); return file;
  };
  try {
    const unified = await getRun(unifiedId, 'localization-unified-candidate');
    const producer = { commit: unified.head_sha, runId: String(unified.id), attempt: String(unified.run_attempt) };
    const unifiedZip = await metadata(await select(unified, `unified-candidate-receipts-${unified.id}-${unified.run_attempt}`));
    const plan = await zipJSON(unifiedZip, 'release-plan.json');
    const pushed = await zipJSON(unifiedZip, 'unified/pushed.json');
    const assembledBytes = await execute('unzip', ['-p', unifiedZip, 'unified/assembled.json'], { encoding: 'buffer', maxBuffer: 10 * 1024 ** 2 });
    const assembled = JSON.parse(assembledBytes.stdout);
    const catalog = await zipJSON(unifiedZip, 'unified/context/payload/release-set.json');
    for (const p of [plan.producer, pushed.producer, assembled.producer]) assert.deepEqual(p, producer);
    assert.equal(pushed.assembledSha256, sha(assembledBytes.stdout));
    assert.equal(pushed.status, 'unified-candidate-pushed-restore-pending');
    assert.match(pushed.digest, /^kishikawakatsumi\/applelocalization-data@sha256:[a-f0-9]{64}$/);
    hex(pushed.identity); hex(pushed.catalogSha256);
    assert.deepEqual(catalog, assembled.catalog);
    const candidatePlans = new Map();
    for (const pin of plan.pins) {
      const run = await getRun(pin.runId, 'localization-candidate-pipeline');
      assert.equal(run.head_sha, pin.commit); assert.equal(run.run_attempt, pin.attempt);
      assert.equal(pin.artifact.name, `candidate-sql-${pin.target}-${run.id}-${run.run_attempt}`);
      await select(run, pin.artifact.name, pin.artifact);
      await select(run, `candidate-pushed-${pin.target}-${run.id}-${run.run_attempt}`);
      if (!candidatePlans.has(run.id)) {
        const zip = await metadata(await select(run, `candidate-plan-${run.id}-${run.run_attempt}`));
        candidatePlans.set(run.id, await zipJSON(zip, 'candidate-plan.json'));
      }
    }
    const components = validateLineage(plan, catalog, candidatePlans);
    for (const c of components) {
      assert.equal(c.source.repository, repository);
      const run = await getRun(c.source.runId, 'localization-release-batch');
      assert.equal(run.head_sha, c.source.commit); assert.equal(run.run_attempt, c.source.attempt);
      assert.equal(c.artifact.name, `intermediate-${c.key}-${run.id}-${run.run_attempt}`);
      await select(run, c.artifact.name, c.artifact);
    }
    const selected = [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(new Set(selected.map(a => a.name)).size, selected.length);
    const tag = `data-r${unified.id}-a${unified.run_attempt}`;
    let releases = (await pages('releases?per_page=100')).filter(r => r.tag_name === tag);
    const archiveCommit = releaseCommit(releases, process.env.GITHUB_SHA);
    const manifest = {
      formatVersion: 1, repository, tag, archiveCommit, producer,
      image: { reference: pushed.digest, identity: pushed.identity, catalogSha256: pushed.catalogSha256 },
      datasets: catalog.datasets, artifacts: selected,
      retention: 'Exact Actions ZIPs, including intermediate quarantine originals, SQL and receipts. No new extraction or deployment.',
      verification: 'Artifact hashes and producer lineage verified; original audit/restore status is preserved without reclassification.',
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const checksumBytes = Buffer.from([...selected.map(a => `${a.digest.slice(7)}  ${a.name}.zip`),
      `${sha(manifestBytes)}  data-manifest.json`].join('\n') + '\n');
    const expected = [...selected.map(a => ({ name: `${a.name}.zip`, size: a.size, digest: a.digest })),
      { name: 'data-manifest.json', size: manifestBytes.length, digest: `sha256:${sha(manifestBytes)}` },
      { name: 'SHA256SUMS', size: checksumBytes.length, digest: `sha256:${sha(checksumBytes)}` }];
    const notes = `Data archive for ${catalog.datasets.length} OS series / ${components.length} components.\n\n` +
      `Intermediate packages (including quarantined originals), import SQL, checksums and producer receipts are retained as exact Actions ZIPs. Extract the relevant ZIP before using the original package/SQL tools.\n\n` +
      `DB image: \`${pushed.digest}\`\n\nSource run: https://github.com/${repository}/actions/runs/${unified.id}\n\n` +
      `This is a retention operation, not a new extraction, full OS coverage claim, validation run or production deployment. Original receipts retain their original verification status.\n`;
    console.log(JSON.stringify({ tag, targets: catalog.datasets.length, components: components.length,
      assets: expected.length, bytes: selected.reduce((n, a) => n + a.size, 0), publish }));
    if (!publish) return manifest;
    if (releases.length === 0) {
      // Never overwrite a pre-existing tag, even if it has no release.
      const refs = await api(`git/matching-refs/tags/${tag}`);
      assert.ok(!refs.some(r => r.ref === `refs/tags/${tag}`), 'Existing tag without release');
      await gh('release', 'create', tag, '--repo', repository, '--target', archiveCommit,
        '--draft', '--prerelease', '--latest=false', '--title', tag, '--notes', notes);
      releases = (await pages('releases?per_page=100')).filter(r => r.tag_name === tag);
    }
    assert.equal(releases.length, 1);
    let release = releases[0];
    assert.equal(release.target_commitish, archiveCommit);
    assert.equal(release.prerelease, true);
    const uploaded = await pages(`releases/${release.id}/assets?per_page=100`);
    for (const a of uploaded) {
      const e = expected.find(x => x.name === a.name);
      assert.ok(e, 'Unexpected existing release asset'); verifyAssetSet([a], [e]);
    }
    if (!release.draft) {
      verifyAssetSet(uploaded, expected);
      assert.equal((await api(`commits/${tag}`)).sha, archiveCommit);
      console.log(`Already archived: ${release.html_url}`);
      return manifest;
    }
    for (const a of expected) {
      if (uploaded.some(x => x.name === a.name)) continue;
      const original = selected.find(x => `${x.name}.zip` === a.name);
      let file;
      if (original) file = files.get(original.id) ?? await download(original, dir);
      else {
        file = join(dir, a.name);
        await writeFile(file, a.name === 'data-manifest.json' ? manifestBytes : checksumBytes, { flag: 'wx' });
      }
      await gh('release', 'upload', tag, file, '--repo', repository); // no --clobber
      const remote = (await pages(`releases/${release.id}/assets?per_page=100`)).filter(x => x.name === a.name);
      verifyAssetSet(remote, [a]);
      if (original) files.delete(original.id);
      await rm(file);
      console.log(`Verified ${a.name}`);
    }
    verifyAssetSet(await pages(`releases/${release.id}/assets?per_page=100`), expected);
    // A fresh draft has no Git tag yet; GitHub creates it on publication.
    // If a resumed draft already has a tag, it must still point to its archival code.
    const refs = await api(`git/matching-refs/tags/${tag}`);
    if (refs.some(r => r.ref === `refs/tags/${tag}`)) {
      assert.equal((await api(`commits/${tag}`)).sha, archiveCommit);
    }
    release = JSON.parse(await gh('api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`,
      '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false'));
    assert.equal(release.draft, false);
    assert.equal((await api(`commits/${tag}`)).sha, archiveCommit);
    console.log(`Archived: ${release.html_url}`);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
      `Saved ${expected.length} verified assets: [${tag}](${release.html_url})\n`, { flag: 'a' });
    return manifest;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'unified-run': { type: 'string' }, publish: { type: 'boolean', default: false } } });
  await archive(Number(values['unified-run']), values.publish);
}
