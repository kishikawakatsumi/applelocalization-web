import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectionStages } from '../scripts/collect-image-localizations.mjs';
import { fileHash, runCheckpoints, withCollectionLock, writeJson } from '../scripts/collection-checkpoints.mjs';
import { exportTransfer } from '../scripts/package-transfer.mjs';
import { sealTransfer } from '../scripts/sealed-package-transfer.mjs';
import { validateApproval, verifyRun, verifyArtifact, receiveActionsPackage } from '../scripts/receive-actions-package.mjs';

const run = promisify(execFile);
const python = '/usr/bin/python3';
const unpack = fileURLToPath(new URL('../scripts/unpack-transfer-artifact.py', import.meta.url));
function approval() {
  return { formatVersion: 1, repository: 'owner/repo', repositoryId: 10, runId: 20, runAttempt: 1, commit: 'a'.repeat(40), workflow: '.github/workflows/localization-transfer-trial.yml', event: 'workflow_dispatch', branch: 'main', reportSha256: 'b'.repeat(64), transportSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), recipient: 'age1' + 'a'.repeat(58), sourceId: 'test', artifacts: {
    report: { id: 30, name: 'localization-transfer-report-20-1', bytes: 1000, sha256: 'e'.repeat(64) }, sealed: { id: 31, name: 'localization-sealed-20-1', bytes: 1000, sha256: 'f'.repeat(64) },
  } };
}
function runMetadata(a) { return { id: a.runId, run_attempt: a.runAttempt, repository: { full_name: a.repository, id: a.repositoryId }, head_repository: { full_name: a.repository, id: a.repositoryId }, head_sha: a.commit, head_branch: a.branch, path: a.workflow, event: a.event, status: 'completed', conclusion: 'success' }; }
function artifactMetadata(e, a) { return { id: e.id, name: e.name, size_in_bytes: e.bytes, digest: 'sha256:' + e.sha256, expired: false, workflow_run: { id: a.runId, head_sha: a.commit, repository_id: a.repositoryId, head_repository_id: a.repositoryId } }; }
test('receiver trust gate rejects wrong run, rerun, fork, commit, workflow, failure, expiry and artifacts', () => {
  const a = approval(); validateApproval(a); verifyRun(runMetadata(a), a);
  for (const patch of [{ id: 21 }, { run_attempt: 2 }, { head_repository: { full_name: 'fork/repo', id: 11 } }, { head_sha: '0'.repeat(40) }, { path: 'other.yml' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) assert.throws(() => verifyRun({ ...runMetadata(a), ...patch }, a));
  const e = a.artifacts.sealed, meta = artifactMetadata(e, a); verifyArtifact(meta, e, a);
  for (const patch of [{ expired: true }, { id: 32 }, { name: 'other' }, { digest: 'sha256:' + '0'.repeat(64) }, { size_in_bytes: 2000 }, { workflow_run: {} }]) assert.throws(() => verifyArtifact({ ...meta, ...patch }, e, a));
  for (const patch of [{ repository: '../repo' }, { runId: '../escape' }, { commit: 'main' }, { event: 'pull_request' }]) assert.throws(() => validateApproval({ ...a, ...patch }));
});
test('artifact ZIP extractor refuses traversal, nested paths, symlinks, duplicate names and oversized output before creating destination', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'artifact-zip-test-'));
  for (const [i, name] of ['../escape', '/tmp/escape', 'nested/transport.json', 'identity.txt', 'link', 'duplicate', 'oversize'].entries()) {
    const archive = join(temp, i + '.zip'), output = join(temp, 'out-' + i);
    await run(python, ['-c', 'import sys,zipfile,stat; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); n=sys.argv[2]; e=zipfile.ZipInfo("report.json" if n in ("link","duplicate","oversize") else n); e.external_attr=(stat.S_IFLNK|0o777)<<16 if n=="link" else 0; z.writestr(e,b"x"*(9*1024**2) if n=="oversize" else b"{}"); z.writestr("report.json",b"{}") if n=="duplicate" else None; z.close()', archive, name]);
    await assert.rejects(run(python, [unpack, '--archive', archive, '--output', output, '--kind', 'report']));
    await assert.rejects(lstat(output), /ENOENT/);
  }
});
test('checkpoint receiver retries partial download, resumes offline, refuses duplicates/concurrency/drift/corruption', { skip: !process.env.TEST_AGE || !process.env.TEST_AGE_KEYGEN }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'actions-receive-test-')), image = join(temp, 'image'), collection = join(temp, 'collection');
  await mkdir(join(image, 'Demo.app/en.lproj'), { recursive: true });
  await writeFile(join(image, 'Demo.app/en.lproj/Localizable.strings'), '{"key":"value"}');
  await withCollectionLock(collection, () => runCheckpoints({ output: collection, identity: { test: true }, minimumFreeBytes: 0, stages: collectionStages({ root: image, label: 'fixture', minimumFreeBytes: 0, extractionOptions: { requireReadOnlyMount: false, decode: b => JSON.parse(b) } }) }));
  const exported = await exportTransfer({ collection, output: join(temp, 'transfer'), minimumFreeBytes: 0 });
  const identity = join(temp, 'key'); await run(process.env.TEST_AGE_KEYGEN, ['-o', identity]);
  const recipient = (await run(process.env.TEST_AGE_KEYGEN, ['-y', identity])).stdout.trim();
  const age = process.env.TEST_AGE, ageSha256 = await fileHash(age);
  const sealed = await sealTransfer({ input: join(temp, 'transfer'), output: join(temp, 'sealed'), manifestSha256: exported.manifestSha256, recipient, age, ageSha256, minimumFreeBytes: 0 });
  const a = { ...approval(), sourceId: exported.sourceId, manifestSha256: exported.manifestSha256, transportSha256: sealed.transportSha256, recipient };
  await mkdir(join(temp, 'report'));
  await writeJson(join(temp, 'report/report.json'), { status: 'hosted-audited-package-encrypted-not-received', senderCommit: a.commit, runId: String(a.runId), runAttempt: '1', sourceId: a.sourceId, recipient, ...sealed });
  // status must describe sender completion, not the seal operation.
  const reportPath = join(temp, 'report/report.json'), report = JSON.parse(await readFile(reportPath)); report.status = 'hosted-audited-package-encrypted-not-received'; await writeFile(reportPath, JSON.stringify(report));
  a.reportSha256 = await fileHash(reportPath);
  for (const kind of ['report', 'sealed']) {
    const archive = join(temp, kind + '.zip');
    await run(python, ['-c', 'import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[2],"w"); [(z.write(p,p.name)) for p in pathlib.Path(sys.argv[1]).iterdir()]; z.close()', join(temp, kind), archive]);
    a.artifacts[kind].bytes = (await lstat(archive)).size; a.artifacts[kind].sha256 = await fileHash(archive);
  }
  const approved = join(temp, 'approval.json'); await writeJson(approved, a);
  const root = join(temp, 'receiver'); await mkdir(root);
  const options = { approval: approved, approvalSha256: await fileHash(approved), root, age, ageSha256, identity, minimumFreeBytes: 0 };
  let failDownload = true, downloads = 0;
  const client = { json: async endpoint => endpoint.endsWith('/runs/20') ? runMetadata(a) : artifactMetadata(a.artifacts[endpoint.endsWith('/30') ? 'report' : 'sealed'], a), download: async (endpoint, dest) => {
    downloads++;
    if (failDownload) { await writeFile(dest, 'partial'); throw new Error('simulated disconnect'); }
    await copyFile(join(temp, endpoint.endsWith('/30/zip') ? 'report.zip' : 'sealed.zip'), dest);
  } };
  await assert.rejects(receiveActionsPackage({ ...options, client }), /simulated disconnect/);
  const job = join(root, 'run-20-attempt-1'); await assert.rejects(lstat(join(job, 'fetch.complete.json')), /ENOENT/);
  failDownload = false; await receiveActionsPackage({ ...options, client, through: 'fetch' }); assert.equal(downloads, 3);
  assert.ok((await readdir(job)).includes('fetch-attempt-0002'));
  const offline = { json: async () => { throw new Error('must not request network'); }, download: async () => { throw new Error('must not download'); } };
  await assert.rejects(receiveActionsPackage({ ...options, client: offline, progress: e => { if (e.stage === 'accept' && e.status === 'running') throw new Error('simulated stop'); } }), /simulated stop/);
  const result = await receiveActionsPackage({ ...options, client: offline }); assert.match(result.accepted, /accept-attempt-0002/);
  assert.equal((await receiveActionsPackage({ ...options, client: offline })).accepted, result.accepted);
  await mkdir(join(job, '.collection-lock'));
  await assert.rejects(receiveActionsPackage({ ...options, client: offline }), /EEXIST/);
  // A forced-termination lock is intentionally not removed by a new worker.
  const { rmdir } = await import('node:fs/promises'); await rmdir(join(job, '.collection-lock'));
  await assert.rejects(receiveActionsPackage({ ...options, approvalSha256: '0'.repeat(64), client: offline }), /Approval file changed/);
  await assert.rejects(receiveActionsPackage({ ...options, ageSha256: '0'.repeat(64), client: offline }), /changed/);
  await writeFile(join(result.accepted, 'payload/package/catalog.json'), '{}');
  await assert.rejects(receiveActionsPackage({ ...options, client: offline }), /Completed stage changed/);
});
