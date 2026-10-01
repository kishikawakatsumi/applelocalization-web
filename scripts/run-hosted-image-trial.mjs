// Fixed AppOS/SystemOS trials only. No DB, publication or full IPSW download.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, statfs } from 'node:fs/promises';
import { arch, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { acquireComponent, regularFiles, validateAcquisition } from './acquire-ipsw-component.mjs';
import { checkSpace, fileHash, writeJson } from './collection-checkpoints.mjs';
import { decodePlist } from './extract-mounted-bundle.mjs';
import { runImageJob } from './run-image-job.mjs';

export const trialConfigUrl = new URL('./hosted-appos-trial.json', import.meta.url);
const streams = ['resources', 'tables', 'occurrences', 'issues', 'symlinks'];
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const reserve = 10 * 1024 ** 3;

export function validateTrial(config, allowDownload, profile = 'appos') {
  assert.equal(allowDownload, true, 'Real image trial requires --allow-download');
  assert.ok(['appos', 'systemos'].includes(profile), 'Unknown fixed trial profile');
  assert.equal(config.formatVersion, 1);
  const encrypted = profile === 'systemos';
  assert.equal(config.input.component, encrypted ? 'Cryptex1,SystemOS' : 'Cryptex1,AppOS');
  assert.match(config.input.imagePath, encrypted ? /^[A-Za-z0-9_-]+\.dmg\.aea$/ : /^[A-Za-z0-9_-]+\.dmg$/);
  for (const key of ['maximumDownloadBytes', 'maximumImageBytes']) {
    const maximum = encrypted ? (key === 'maximumDownloadBytes' ? 3 : 6) * 1024 ** 3 : 128 * 1024 ** 2;
    assert.ok(Number.isSafeInteger(config.input[key]) && config.input[key] > 0 && config.input[key] <= maximum);
  }
  if (encrypted) {
    assert.ok(Number.isSafeInteger(config.expectedDownload?.bytes) && config.expectedDownload.bytes > 0 && config.expectedDownload.bytes <= config.input.maximumDownloadBytes);
    assert.match(config.expectedDownload.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(config.tool.url, 'https://github.com/blacktop/ipsw/releases/download/v3.1.728/ipsw_3.1.728_macOS_arm64.tar.gz');
  assert.ok(Number.isSafeInteger(config.tool.archiveBytes) && config.tool.archiveBytes > 0 && config.tool.archiveBytes <= 32 * 1024 ** 2);
  assert.ok(Number.isSafeInteger(config.expectedImage.bytes) && config.expectedImage.bytes > 0 && config.expectedImage.bytes <= config.input.maximumImageBytes);
  for (const hash of [config.tool.archiveSha256, config.tool.binarySha256, config.expectedImage.sha256, config.baseline.catalogSha256, ...streams.map(s => config.baseline.contentHashes[s])]) assert.match(hash, /^[a-f0-9]{64}$/);
  validateAcquisition({ ...config.input, tool: { path: '/pinned/ipsw', sha256: config.tool.binarySha256 } });
}

export function compareBaseline(report, baseline) {
  assert.equal(report.status, 'prepared-not-imported');
  assert.equal(report.sourceId, baseline.sourceId, 'Source identity differs');
  assert.deepEqual(report.counts, baseline.counts, 'Occurrence/resource counts differ');
  for (const name of streams) assert.equal(report.contentHashes[name], baseline.contentHashes[name], `${name} logical content differs`);
  assert.equal(report.catalogSha256, baseline.catalogSha256, 'Language/bundle catalog differs');
  // sources embeds host/run-specific metadata; compressed bytes and timestamps need not match.
  return { status: 'baseline-logical-content-verified', streams, catalog: true, counts: true, sourcesExcluded: 'Contains host/run-specific extraction metadata' };
}

export async function verifyTrialPayload(file, expected) {
  assert.equal((await lstat(file)).size, expected.bytes, 'Payload size differs from baseline');
  assert.equal(await fileHash(file), expected.sha256, 'Payload hash differs from baseline');
  return { bytes: expected.bytes, sha256: expected.sha256 };
}

export async function runHostedImageTrial({ output, allowDownload = false, profile = 'appos' }) {
  assert.equal(allowDownload, true, 'Real image trial requires --allow-download');
  assert.ok(['appos', 'systemos'].includes(profile), 'Unknown fixed trial profile');
  const configUrl = new URL(`./hosted-${profile}-trial.json`, import.meta.url);
  const config = await readJson(configUrl);
  validateTrial(config, allowDownload, profile);
  const encrypted = profile === 'systemos';
  assert.equal(process.platform, 'darwin'); assert.equal(arch(), 'arm64');
  await mkdir(resolve(output)); // Exclusive, no overwrite or automatic cleanup.
  output = await realpath(output);
  const execute = promisify(execFile);
  const run = async (command, args) => (await execute(command, args, { timeout: 300000, maxBuffer: 8 * 1024 ** 2 })).stdout;
  const report = { status: 'running', startedAt: new Date().toISOString(), syntheticOnly: false, imported: false, published: false,
    architecture: arch(), memoryBytes: totalmem(), node: process.version, input: config.input,
    profile, configSha256: await fileHash(configUrl), samples: [], stages: [], sampledNodeRssMaximumBytes: 0,
    limitations: ['One pinned component, not the latest release, a full OS or an installer trial.',
      'Disk and Node RSS are sampled, not exact peaks. RSS excludes child tools; no network-byte accounting.',
      'Download limits bound output files, not total HTTP traffic. Stage timeouts and space guards are not disk reservations.',
      'Only report.json is retained by Actions. Packages/images are ephemeral, not durable collection outputs.',
      'Forced termination may prevent reporting/cleanup. Normal failures preserve files; hosted runner is disposable.'] };
  let minimumFree = Infinity, monitorError, monitoring = Promise.resolve(), activeStage = 'prepare', timer;
  const sample = async (stage, retain = true) => {
    const fs = await statfs(output), availableBytes = fs.bavail * fs.bsize;
    minimumFree = Math.min(minimumFree, availableBytes);
    report.sampledNodeRssMaximumBytes = Math.max(report.sampledNodeRssMaximumBytes, process.memoryUsage().rss);
    if (retain) report.samples.push({ stage, at: new Date().toISOString(), availableBytes });
    assert.ok(availableBytes >= reserve, 'Trial free space fell below 10 GiB');
  };
  const stageStarts = new Map();
  const progress = event => {
    if (monitorError) throw monitorError;
    if (event.stage) {
      activeStage = event.stage;
      if (event.status === 'running') stageStarts.set(event.stage, Date.now());
      if (['completed', 'verified-and-reused'].includes(event.status)) report.stages.push({ stage: event.stage, status: event.status, at: new Date().toISOString(),
        ...(event.status === 'completed' ? { elapsedMs: Date.now() - stageStarts.get(event.stage) } : {}) });
    }
    console.log(JSON.stringify(event));
  };
  let failure;
  try {
    await sample('start');
    await checkSpace(output, reserve + 512 * 1024 ** 2 + config.input.maximumDownloadBytes + (encrypted ? config.input.maximumImageBytes : 0));
    report.macOS = (await run('/usr/bin/sw_vers', [])).trim();
    report.python = (await run('python3', ['--version'])).trim();
    timer = setInterval(() => { monitoring = monitoring.then(() => sample(activeStage, false)).catch(e => { monitorError ??= e; }); }, 1000);
    const toolDir = join(output, 'tool'); await mkdir(toolDir);
    const archive = join(toolDir, 'ipsw.tar.gz');
    const toolStarted = Date.now();
    await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '30', '--max-time', '240', '--max-filesize', String(32 * 1024 ** 2), '--output', archive, config.tool.url]);
    assert.equal((await lstat(archive)).size, config.tool.archiveBytes);
    assert.equal(await fileHash(archive), config.tool.archiveSha256, 'Tool archive hash mismatch');
    // Extract only the executable and license from the hash-pinned official archive.
    await run('/usr/bin/tar', ['-xzf', archive, '-C', toolDir, 'ipsw', 'LICENSE']);
    const tool = { path: join(toolDir, 'ipsw'), sha256: config.tool.binarySha256 };
    assert.equal(await fileHash(tool.path), tool.sha256, 'Tool executable hash mismatch');
    report.tool = { ...config.tool, version: (await run(tool.path, ['version'])).trim(), setupElapsedMs: Date.now() - toolStarted };
    await sample('tool-ready');
    const spec = join(output, 'input.json');
    await writeJson(spec, { ...config.input, tool });
    const jobRoot = join(output, 'job');
    if (encrypted) {
      // Refuse changed encrypted input BEFORE passing it to the decrypter.
      const downloaded = await acquireComponent({ spec, output: join(jobRoot, 'acquisition'), through: 'download', progress });
      const payload = await readJson(join(downloaded.outputs.download, 'file.json'));
      report.downloaded = { ...await verifyTrialPayload(payload.path, config.expectedDownload), encrypted: true };
      await sample('encrypted-input-verified');
    }
    const acquired = await acquireComponent({ spec, output: join(jobRoot, 'acquisition'), progress });
    const collectionInput = await readJson(acquired.collectionSpec);
    // Check against the independently retained local/remote baseline before mounting.
    report.image = { ...await verifyTrialPayload(collectionInput.image.path, config.expectedImage), encrypted: false };
    report.manifestBytes = (await lstat(collectionInput.manifest.path)).size;
    await sample('acquired');
    const job = await runImageJob({ kind: 'ipsw', spec, output: jobRoot, allowDownload: true, progress });
    report.jobStatus = job.status;
    const packageRoot = join(job.collection.outputs.package, 'data');
    const packaged = await readJson(join(packageRoot, 'report.json'));
    report.package = { sourceId: packaged.sourceId, counts: packaged.counts, contentHashes: packaged.contentHashes, catalogSha256: packaged.catalogSha256,
      bytes: (await regularFiles(packageRoot)).reduce((sum, f) => sum + f.bytes, 0) };
    report.audit = await readJson(join(job.collection.outputs['package-audit'], 'report.json'));
    assert.equal(report.audit.status, 'package-content-verified');
    report.baselineComparison = compareBaseline(packaged, config.baseline);
    report.versionEvidence = (await readJson(join(jobRoot, 'collection', 'collection.json'))).identity.versionEvidence;
    await sample('verified');
    report.status = `hosted-${profile}-package-and-baseline-verified`;
  } catch (error) { failure = error; report.status = 'failed-preserved'; report.error = String(error).slice(0, 3000); }
  finally {
    clearInterval(timer); await monitoring;
    try {
      const images = decodePlist(Buffer.from(await run('/usr/bin/hdiutil', ['info', '-plist']))).images ?? [];
      report.detached = !images.some(i => i['image-path']?.startsWith(output + '/'));
      assert.equal(report.detached, true, 'Trial image remains attached; inspect before cleanup');
      await sample('finished');
      if (monitorError) throw monitorError;
    } catch (error) { failure ??= error; report.status = 'failed-preserved'; report.finalCheckError = String(error).slice(0, 3000); }
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.minimumObservedFreeBytes = Number.isFinite(minimumFree) ? minimumFree : null;
    try { report.outputBytes = (await regularFiles(output)).reduce((sum, f) => sum + f.bytes, 0); }
    catch (error) { report.outputMeasurementError = String(error).slice(0, 1000); }
    await writeJson(join(output, 'report.json'), report);
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, profile: { type: 'string', default: 'appos' }, 'allow-download': { type: 'boolean', default: false } } });
  assert.ok(values.output, '--output required');
  const report = await runHostedImageTrial({ output: values.output, profile: values.profile, allowDownload: values['allow-download'] });
  console.log(JSON.stringify({ status: report.status, counts: report.package.counts, elapsedMs: report.elapsedMs, minimumObservedFreeBytes: report.minimumObservedFreeBytes }));
}
