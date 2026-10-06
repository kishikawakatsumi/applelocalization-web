// Synthetic APFS only. No network, Apple images, sudo, DB or user environment dump.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, totalmem } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePlist } from '../extraction/extract-mounted-bundle.mjs';
import { extractMountedImage } from '../extraction/extract-mounted-image.mjs';
import { selectImageVolume } from './select-image-volume.mjs';
import { fileHash, writeJson } from '../shared/collection-checkpoints.mjs';

export const preflightMinimumBytes = 2 * 1024 ** 3;
export function requirePreflightCapacity(bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= preflightMinimumBytes, 'Synthetic preflight requires 2 GiB free; no cleanup is performed');
}
export function ownedImage(images, path, device) {
  const matches = images.filter(i => i['image-path'] === path && i['system-entities']?.some(e => e['dev-entry'] === device));
  assert.equal(matches.length, 1, 'Cannot prove owned image/device association');
  assert.equal(matches[0].writeable, false, 'Image attachment must be read-only');
  return matches[0];
}
export async function preflightRunner({ output }) {
  assert.equal(process.platform, 'darwin', 'Synthetic APFS preflight requires macOS');
  await mkdir(resolve(output)); // Exclusive, never overwrite an earlier attempt.
  output = await realpath(output);
  const execute = promisify(execFile);
  const run = async (cmd, args) => (await execute(cmd, args, { timeout: 120000, maxBuffer: 8 * 1024 ** 2 })).stdout;
  const images = async () => decodePlist(Buffer.from(await run('/usr/bin/hdiutil', ['info', '-plist']))).images ?? [];
  const record = { status: 'running', startedAt: new Date().toISOString(), platform: process.platform, architecture: arch(), memoryBytes: totalmem(), node: process.version, syntheticOnly: true, downloaded: false, samples: [], limitations: ['Synthetic fixture only; not proof that any IPSW, AEA or full installer fits.', 'Free-space delta includes other processes and is sampled, not a reserved capacity or exact peak.', 'No GitHub-hosted success is inferred from a local run.'] };
  const sample = async stage => { const fs = await statfs(output); const bytes = fs.bavail * fs.bsize; record.samples.push({ stage, at: new Date().toISOString(), availableBytes: bytes }); requirePreflightCapacity(bytes); };
  const imagePath = join(output, 'synthetic.dmg');
  let device = null, error = null;
  try {
    await sample('start');
    record.macOS = (await run('/usr/bin/sw_vers', [])).trim();
    record.python = (await run('python3', ['--version'])).trim();
    await run('python3', ['-c', 'import plistlib; assert plistlib.loads(plistlib.dumps({"ok": True}))["ok"]']);
    const hdiutilInfo = decodePlist(Buffer.from(await run('/usr/bin/hdiutil', ['info', '-plist'])));
    record.hdiutil = { framework: hdiutilInfo.framework, revision: hdiutilInfo.revision };
    const fixture = join(output, 'fixture'), bundle = join(fixture, 'Preflight.app', 'Contents');
    await mkdir(bundle, { recursive: true });
    const plist = body => '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' + body + '</dict></plist>';
    await writeFile(join(bundle, 'Info.plist'), plist('<key>CFBundleIdentifier</key><string>org.example.localization.preflight</string>'));
    for (const [language, text] of [['en', 'Open'], ['ja', '開く']]) {
      const dir = join(bundle, 'Resources', language + '.lproj'); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'Localizable.strings'), plist('<key>Open</key><string>' + text + '</string><key>FSPersonalities</key><dict><key>name</key><string>' + text + '</string></dict>'));
    }
    await run('/usr/bin/plutil', ['-lint', join(bundle, 'Info.plist')]);
    await run('/usr/bin/hdiutil', ['create', '-size', '128m', '-fs', 'APFS', '-srcfolder', fixture, '-volname', 'LocalizationPreflight', '-format', 'UDRO', imagePath]);
    record.imageSha256 = await fileHash(imagePath); await sample('created');
    const attached = decodePlist(Buffer.from(await run('/usr/bin/hdiutil', ['attach', imagePath, '-readonly', '-nomount', '-plist'])));
    const entities = attached['system-entities'];
    device = entities.find(e => /^\/dev\/disk[0-9]+$/.test(e['dev-entry']))?.['dev-entry'];
    assert.ok(device, 'No owned disk handle; inspect leftover synthetic image');
    ownedImage(await images(), imagePath, device);
    const selected = selectImageVolume(entities.filter(e => e['potentially-mountable']).map(e => ({ device: e['dev-entry'] })), null);
    assert.match(selected.device, /^\/dev\/disk[0-9]+(?:s[0-9]+)*$/);
    const root = join(output, 'mount'); await mkdir(root);
    await run('/usr/sbin/diskutil', ['mount', 'readOnly', 'nobrowse', '-mountOptions', 'noowners', '-mountPoint', root, selected.device]);
    const info = decodePlist(Buffer.from(await run('/usr/sbin/diskutil', ['info', '-plist', selected.device])));
    assert.equal(info.MountPoint, root); assert.equal(info.Writable, false);
    assert.ok(ownedImage(await images(), imagePath, device)['system-entities'].some(e => e['mount-point'] === root));
    record.readOnly = true; await sample('mounted');
    const scan = await extractMountedImage({ root, output: join(output, 'scan'), label: 'synthetic-runner-preflight', minimumFreeBytes: preflightMinimumBytes });
    assert.equal(scan.counts.rows, 4); assert.equal(scan.counts.structuredRows, 2);
    assert.equal(scan.counts.failedFiles, 0); assert.equal(scan.counts.enumerationErrors, 0);
    const auditor = fileURLToPath(new URL('../extraction/audit-image-originals.py', import.meta.url));
    await run('python3', ['-B', auditor, '--root', root, '--scan', join(output, 'scan'), '--output', join(output, 'original-audit.json')]);
    const audit = JSON.parse(await readFile(join(output, 'original-audit.json')));
    assert.equal(audit.status, 'all-image-rows-match-originals');
    record.counts = scan.counts; record.originalAudit = audit.status;
    await sample('audited'); record.status = 'synthetic-readonly-mount-and-extraction-verified';
  } catch (e) { error = e; record.status = 'failed-preserved'; record.error = String(e).slice(0, 3000); }
  finally {
    try {
      if (device) { ownedImage(await images(), imagePath, device); await run('/usr/bin/hdiutil', ['detach', device]); }
      assert.ok(!(await images()).some(i => i['image-path'] === imagePath), 'Synthetic image remains attached');
      record.detached = true;
    } catch (e) { error ??= e; record.status = 'failed-cleanup-required'; record.cleanupError = String(e).slice(0, 3000); }
    try { await sample('finished'); } catch (e) { error ??= e; if (record.status !== 'failed-cleanup-required') record.status = 'failed-preserved'; }
    record.finishedAt = new Date().toISOString();
    record.minimumObservedFreeBytes = Math.min(...record.samples.map(s => s.availableBytes));
    await writeJson(join(output, 'report.json'), record);
  }
  if (error) throw error;
  return record;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  assert.ok(values.output, '--output required');
  console.log(JSON.stringify(await preflightRunner(values), null, 2));
}
