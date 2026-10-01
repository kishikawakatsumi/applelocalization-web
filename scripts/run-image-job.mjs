// One component per job; no DB imports, publication, tool installation or input discovery.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { acquireComponent, validateAcquisition } from './acquire-ipsw-component.mjs';
import { collectImage } from './collect-image-localizations.mjs';
import { fileHash, writeJson, withCollectionLock } from './collection-checkpoints.mjs';
import { safeRead } from './inspect-unlocalized-resources.mjs';

export function validateImageJob({ kind, spec, allowDownload = false }) {
  assert.ok(['image', 'ipsw'].includes(kind), 'Choose image or ipsw');
  assert.equal(typeof spec, 'string'); assert.ok(spec.length);
  assert.ok(kind === 'ipsw' || !allowDownload, 'Download permission only applies to ipsw');
  if (kind === 'ipsw') assert.equal(allowDownload, true, 'IPSW acquisition requires --allow-download');
}

export async function runImageJob(options) {
  validateImageJob(options);
  assert.equal(process.platform, 'darwin', 'Image collection requires macOS');
  const spec = await realpath(options.spec), input = JSON.parse(await readFile(spec));
  if (options.kind === 'ipsw') validateAcquisition(input);
  const output = resolve(options.output);
  assert.ok(spec !== output && !spec.startsWith(output + '/'), 'Keep input spec outside job output');
  return withCollectionLock(output, async () => {
    const identity = { formatVersion: 1, kind: options.kind, specSha256: await fileHash(spec) };
    try { assert.deepEqual(JSON.parse(await safeRead(output, 'job.json')), identity, 'Job input changed; choose a new output'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(join(output, 'job.json'), identity); }
    await mkdir(join(output, 'runs'), { recursive: true });
    const run = await mkdtemp(join(output, 'runs', 'attempt-'));
    const record = { status: 'running', ...identity, startedAt: new Date().toISOString(), imported: false, published: false };
    try {
      let collectionSpec = spec;
      if (options.kind === 'ipsw') {
        record.acquisition = await acquireComponent({ spec, output: join(output, 'acquisition'), progress: options.progress });
        assert.equal(record.acquisition.status, 'local-image-prepared-not-collected');
        collectionSpec = record.acquisition.collectionSpec;
      }
      record.collection = await collectImage({ spec: collectionSpec, output: join(output, 'collection'), progress: options.progress });
      assert.equal(record.collection.through, 'package-audit');
      record.status = 'image-job-package-verified-not-imported';
      return record;
    } catch (error) {
      record.status = 'failed-preserved'; record.error = String(error); throw error;
    } finally {
      record.finishedAt = new Date().toISOString();
      await writeJson(join(run, 'result.json'), record);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { kind: { type: 'string' }, spec: { type: 'string' }, output: { type: 'string' }, 'allow-download': { type: 'boolean', default: false } } });
  assert.ok(values.output, '--output required');
  const result = await runImageJob({ ...values, allowDownload: values['allow-download'], progress: v => console.log(JSON.stringify(v)) });
  console.log(JSON.stringify({ status: result.status }));
}
