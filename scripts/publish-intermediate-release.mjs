// Run only in the explicit tools publishing job; existing releases are never overwritten.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fileHash } from './collection-checkpoints.mjs';
import { verifyReleaseAssets } from './verify-release-assets.mjs';

export function validateReleaseForPublication(release, { tag, commit, assets }) {
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(typeof release.draft, 'boolean');
  assert.equal(release.prerelease, true); assert.equal(release.tag_name, tag);
  assert.equal(release.target_commitish, commit, 'Draft source commit differs');
  assert.deepEqual(release.assets.map(x => ({ name: x.name, size: x.size, digest: x.digest })).sort((x, y) => x.name.localeCompare(y.name)),
    [...assets].sort((x, y) => x.name.localeCompare(y.name)), 'Uploaded release asset digests differ; draft preserved');
}

export async function publishIntermediateRelease({ input, output, artifactSha256, allowPublicData = false, resumeReleaseId, source }) {
  assert.equal(allowPublicData, true, 'Explicit public parsed-data approval required');
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'kishikawakatsumi/applelocalization-tools');
  if (resumeReleaseId !== undefined) {
    assert.ok(Number.isSafeInteger(resumeReleaseId) && resumeReleaseId > 0);
    assert.ok(source, 'Resuming requires explicit original producer pins');
  } else assert.equal(source, undefined, 'Producer override only allowed for an explicitly identified release');
  const commit = source?.commit ?? process.env.GITHUB_SHA;
  assert.match(commit ?? '', /^[a-f0-9]{40}$/);
  const runId = source?.runId ?? process.env.GITHUB_RUN_ID, attempt = source?.attempt ?? process.env.GITHUB_RUN_ATTEMPT;
  assert.match(runId ?? '', /^[0-9]+$/); assert.match(attempt ?? '', /^[0-9]+$/);
  const checked = await verifyReleaseAssets({ input, output, artifactSha256 });
  const artifact = JSON.parse(await readFile(join(input, 'artifact.json')));
  assert.equal(artifact.provenance.collectorRepository, repository); assert.equal(artifact.provenance.collectorCommit, commit);
  assert.equal(artifact.provenance.runId, runId); assert.equal(artifact.provenance.runAttempt, attempt);
  const a = artifact.provenance.acquisition;
  assert.equal(a.os, 'iOS'); assert.equal(a.version, '26.1'); assert.equal(a.build, '23B85'); assert.equal(a.component, 'OS');
  assert.equal(artifact.completeOS, false);
  const tag = `intermediate-ios26.1-23B85-os-r${runId}-${attempt}`;
  const run = async args => (await promisify(execFile)('gh', args, { timeout: 900000, maxBuffer: 8 * 1024 ** 2 })).stdout;
  const files = ['artifact.json', 'localization-intermediate.tar'];
  const expected = await Promise.all(files.map(async name => ({ name, size: (await lstat(join(input, name))).size, digest: 'sha256:' + await fileHash(join(input, name)) })));
  // A tag unique to this run/attempt; gh refuses an existing release. Never use --clobber.
  if (resumeReleaseId === undefined) await run(['release', 'create', tag, ...files.map(name => join(input, name)), '--repo', repository, '--target', commit, '--draft', '--prerelease', '--latest=false',
    '--title', 'iOS 26.1 (23B85) OS — parsed intermediate data', '--notes',
    `All ${checked.counts.occurrences} parsed occurrences from the pinned iPhone17,3 normal OS component, all collected languages. Not a complete OS release, not the latest OS, and not a web/database deployment.\n\nNo IPSW, installer, DMG, keys, or original resource files. ${checked.omittedOriginalFiles} quarantined originals are intentionally omitted; their metadata/hashes and unresolved status remain. The archive is a derived intermediate-release format, not a complete old occurrence package. Original inputs may need to be reacquired to repair extraction.\n\nSource code: ${commit}\nActions run: https://github.com/${repository}/actions/runs/${runId}\nartifact.json SHA-256: ${artifactSha256}\narchive SHA-256: ${artifact.archive.sha256}`]);
  // An unpublished draft need not have a Git tag, so the by-tag REST endpoint returns 404.
  const matches = resumeReleaseId === undefined
    ? JSON.parse(await run(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat().filter(r => r.tag_name === tag)
    : [JSON.parse(await run(['api', `repos/${repository}/releases/${resumeReleaseId}`]))];
  assert.equal(matches.length, 1, 'Expected exactly one matching release');
  const release = matches[0];
  const expectedRelease = { tag, commit, assets: expected };
  validateReleaseForPublication(release, expectedRelease);
  if (resumeReleaseId !== undefined) {
    const tagged = JSON.parse(await run(['api', `repos/${repository}/commits/${tag}`]));
    assert.equal(tagged.sha, commit, 'Recovery tag must already point at the pinned producer commit');
  }
  if (release.draft) {
    const published = JSON.parse(await run(['api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`, '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false']));
    validateReleaseForPublication(published, expectedRelease); assert.equal(published.draft, false);
  } else assert.ok(resumeReleaseId !== undefined, 'An existing public release cannot be overwritten');
  console.log(JSON.stringify({ status: 'parsed-intermediate-release-published', tag, url: `https://github.com/${repository}/releases/tag/${tag}`, artifactSha256, archiveSha256: artifact.archive.sha256, imported: false, publishedToWeb: false }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, sha256: { type: 'string' }, 'allow-public-data': { type: 'boolean' },
    ...Object.fromEntries(['resume-release-id', 'source-commit', 'source-run-id', 'source-run-attempt'].map(k => [k, { type: 'string' }])) } });
  const sourceValues = [v['source-commit'], v['source-run-id'], v['source-run-attempt']];
  assert.ok(sourceValues.every(x => x === undefined) || (v['resume-release-id'] && sourceValues.every(x => typeof x === 'string' && x.length > 0)), 'Incomplete producer pins');
  await publishIntermediateRelease({ input: v.input, output: v.output, artifactSha256: v.sha256, allowPublicData: v['allow-public-data'],
    resumeReleaseId: v['resume-release-id'] === undefined ? undefined : Number(v['resume-release-id']),
    source: sourceValues.every(x => x === undefined) ? undefined : { commit: v['source-commit'], runId: v['source-run-id'], attempt: v['source-run-attempt'] } });
}
