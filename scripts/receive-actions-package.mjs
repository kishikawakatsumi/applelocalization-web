// Explicitly approved run only. No discovery of latest runs, key copying, DB or publication.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSpace, fileHash, sha256, runCheckpoints, withCollectionLock, writeJson } from './collection-checkpoints.mjs';
import { verifySealed, unsealTransfer } from './sealed-package-transfer.mjs';
import { receiveTransfer, verifyTransfer } from './package-transfer.mjs';

const hash = /^[a-f0-9]{64}$/;
const reserve = 10 * 1024 ** 3;
const execute = promisify(execFile);
export function validateApproval(a) {
  assert.equal(a.formatVersion, 1);
  assert.match(a.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(!a.repository.split('/').some(p => p === '.' || p === '..'));
  for (const n of [a.runId, a.runAttempt, a.repositoryId]) assert.ok(Number.isSafeInteger(n) && n > 0);
  assert.match(a.commit, /^[a-f0-9]{40}$/);
  assert.equal(a.workflow, '.github/workflows/localization-transfer-trial.yml');
  assert.ok(['push', 'workflow_dispatch'].includes(a.event));
  assert.ok(typeof a.branch === 'string' && a.branch.length > 0);
  for (const name of ['reportSha256', 'transportSha256', 'manifestSha256']) assert.match(a[name], hash);
  assert.match(a.recipient, /^age1[0-9a-z]{58}$/);
  assert.ok(typeof a.sourceId === 'string' && a.sourceId.length > 0);
  for (const kind of ['report', 'sealed']) {
    const artifact = a.artifacts[kind];
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= (kind === 'report' ? 8 * 1024 ** 2 : 2 * 1024 ** 3 + 80 * 1024 ** 2));
    assert.match(artifact.sha256, hash);
    assert.equal(artifact.name, `localization-${kind === 'sealed' ? 'sealed' : 'transfer-report'}-${a.runId}-${a.runAttempt}`);
  }
  assert.notEqual(a.artifacts.report.id, a.artifacts.sealed.id);
}
export function verifyRun(run, a) {
  assert.equal(run.id, a.runId); assert.equal(run.run_attempt, a.runAttempt);
  assert.equal(run.repository?.full_name, a.repository); assert.equal(run.repository?.id, a.repositoryId);
  assert.equal(run.head_repository?.full_name, a.repository); assert.equal(run.head_repository?.id, a.repositoryId);
  assert.equal(run.head_sha, a.commit); assert.equal(run.head_branch, a.branch);
  assert.equal(run.path, a.workflow); assert.equal(run.event, a.event);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
}
export function verifyArtifact(actual, expected, a) {
  assert.equal(actual.id, expected.id); assert.equal(actual.name, expected.name);
  assert.equal(actual.size_in_bytes, expected.bytes); assert.equal(actual.digest, 'sha256:' + expected.sha256);
  assert.equal(actual.expired, false);
  assert.equal(actual.workflow_run?.id, a.runId); assert.equal(actual.workflow_run?.head_sha, a.commit);
  assert.equal(actual.workflow_run?.repository_id, a.repositoryId); assert.equal(actual.workflow_run?.head_repository_id, a.repositoryId);
}
async function command(file, args, options = {}) {
  try { return (await execute(file, args, { timeout: 60000, maxBuffer: 8 * 1024 ** 2, ...options })).stdout; }
  catch { throw new Error('Receiver command failed; check authentication/tool availability. Outputs preserved; credentials and subprocess output not logged.'); }
}
export function githubClient(gh) {
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  return {
    json: async endpoint => JSON.parse(await command(gh, ['api', '--hostname', 'github.com', endpoint], { env })),
    download: async (endpoint, output, expectedBytes) => {
      const child = spawn(gh, ['api', '--hostname', 'github.com', endpoint], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let bytes = 0;
      const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000);
      const closed = new Promise((ok, fail) => { child.on('error', fail); child.on('close', code => code === 0 ? ok() : fail(new Error('Artifact download failed; partial bytes preserved'))); });
      const bounded = new Transform({ transform(chunk, _, next) { bytes += chunk.length; next(bytes <= expectedBytes ? null : new Error('Artifact exceeded approved size'), chunk); } });
      try { await Promise.all([closed, pipeline(child.stdout, bounded, createWriteStream(output, { flags: 'wx', mode: 0o600 }))]); assert.equal(bytes, expectedBytes); }
      finally { clearTimeout(timer); child.kill('SIGTERM'); }
    },
  };
}
async function fingerprint() {
  // Include transitive verifier dependencies, not unrelated repository files.
  const names = ['receive-actions-package.mjs', 'unpack-transfer-artifact.py', 'collection-checkpoints.mjs', 'sealed-package-transfer.mjs', 'package-transfer.mjs', 'inspect-unlocalized-resources.mjs', 'extract-mounted-bundle.mjs'];
  return sha256(JSON.stringify(await Promise.all(names.map(async name => [name, await fileHash(new URL(name, import.meta.url))]))));
}
export async function receiveActionsPackage({ approval, approvalSha256, root, gh, age, ageSha256, identity, python = '/usr/bin/python3',
  through, minimumFreeBytes = reserve, progress = () => {}, client = githubClient(gh) }) {
  assert.match(approvalSha256, hash); assert.match(ageSha256, hash);
  assert.ok((await lstat(approval)).isFile());
  assert.ok((await lstat(approval)).size <= 64 * 1024);
  const raw = await readFile(approval); assert.equal(sha256(raw), approvalSha256, 'Approval file changed');
  const a = JSON.parse(raw); validateApproval(a);
  assert.ok((await lstat(root)).isDirectory(), 'Receiver root must be an existing real directory');
  root = await realpath(root);
  const output = join(root, `run-${a.runId}-attempt-${a.runAttempt}`);
  try { assert.ok((await lstat(output)).isDirectory(), 'Run directory cannot be a symlink'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; await mkdir(output, { mode: 0o700 }); }
  const codeSha256 = await fingerprint();
  const api = `repos/${a.repository}/actions`;
  const stages = [
    { name: 'fetch', run: async dir => {
      // Check upstream trust before any archive download or extraction.
      const run = await client.json(`${api}/runs/${a.runId}`); verifyRun(run, a);
      const metadata = {};
      for (const kind of ['report', 'sealed']) {
        const expected = a.artifacts[kind], actual = await client.json(`${api}/artifacts/${expected.id}`);
        verifyArtifact(actual, expected, a); metadata[kind] = actual;
      }
      await checkSpace(dir, minimumFreeBytes + a.artifacts.report.bytes + a.artifacts.sealed.bytes + 2 * 1024 ** 3 + 80 * 1024 ** 2);
      for (const kind of ['report', 'sealed']) {
        const expected = a.artifacts[kind], archive = join(dir, kind + '.zip');
        await client.download(`${api}/artifacts/${expected.id}/zip`, archive, expected.bytes);
        assert.equal((await lstat(archive)).size, expected.bytes); assert.equal(await fileHash(archive), expected.sha256, 'Artifact ZIP digest differs');
        await command(python, [fileURLToPath(new URL('./unpack-transfer-artifact.py', import.meta.url)), '--archive', archive, '--output', join(dir, kind), '--kind', kind], { timeout: 300000 });
      }
      assert.equal(await fileHash(join(dir, 'report/report.json')), a.reportSha256, 'Sender report differs');
      const report = JSON.parse(await readFile(join(dir, 'report/report.json')));
      assert.equal(report.status, 'hosted-audited-package-encrypted-not-received');
      assert.equal(report.senderCommit, a.commit); assert.equal(report.runId, String(a.runId)); assert.equal(report.runAttempt, String(a.runAttempt));
      for (const key of ['sourceId', 'recipient', 'manifestSha256', 'transportSha256']) assert.equal(report[key], a[key]);
      const sealed = await verifySealed({ input: join(dir, 'sealed'), transportSha256: a.transportSha256 });
      assert.equal(sealed.index.manifestSha256, a.manifestSha256); assert.equal(sealed.index.recipient, a.recipient);
      verifyRun(await client.json(`${api}/runs/${a.runId}`), a); // Reject a rerun started during download.
      await writeJson(join(dir, 'provenance.json'), { repository: a.repository, runId: a.runId, runAttempt: a.runAttempt, commit: a.commit, artifacts: a.artifacts, approvalSha256 });
    } },
    { name: 'decrypt', run: async (dir, outputs) => {
      await unsealTransfer({ input: join(outputs.fetch, 'sealed'), output: join(dir, 'transfer'), transportSha256: a.transportSha256, identity, age, ageSha256, minimumFreeBytes });
    } },
    { name: 'accept', run: async (dir, outputs) => {
      const receipt = await receiveTransfer({ input: join(outputs.decrypt, 'transfer'), output: join(dir, 'accepted'), manifestSha256: a.manifestSha256, minimumFreeBytes });
      assert.equal(receipt.sourceId, a.sourceId);
      await writeJson(join(dir, 'provenance.json'), { approvalSha256, codeSha256, repository: a.repository, runId: a.runId, runAttempt: a.runAttempt, commit: a.commit, transportSha256: a.transportSha256, manifestSha256: a.manifestSha256, receivedOn: hostname(), imported: false, published: false });
    } },
  ];
  return withCollectionLock(output, async () => {
    const result = await runCheckpoints({ output, identity: { approvalSha256, codeSha256, ageSha256 }, stages, through, minimumFreeBytes, progress });
    if (result.outputs.accept) {
      await verifyTransfer({ input: join(result.outputs.accept, 'accepted/payload'), manifestSha256: a.manifestSha256 });
      return { status: 'actions-package-received-verified-not-imported', runId: a.runId, runAttempt: a.runAttempt, accepted: join(result.outputs.accept, 'accepted'), imported: false, published: false };
    }
    return { status: 'receiver-checkpoint-reached', runId: a.runId, through: result.through, output };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['approval', 'approval-sha256', 'root', 'gh', 'age', 'age-sha256', 'identity', 'python', 'through'].map(k => [k, { type: 'string' }])) });
  console.log(JSON.stringify(await receiveActionsPackage({ approval: v.approval, approvalSha256: v['approval-sha256'], root: v.root, gh: v.gh, age: v.age, ageSha256: v['age-sha256'], identity: v.identity, python: v.python,
    through: v.through, progress: e => console.log(JSON.stringify(e)) }), null, 2));
}
