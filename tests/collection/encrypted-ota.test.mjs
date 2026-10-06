import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptOTAFile,
  selectOTAKey,
  validateEncryptedOTA,
} from "../../scripts/collection/acquire-encrypted-ota.mjs";
const spec = JSON.parse(
  await readFile(
    new URL("../../scripts/plans/ios26-encrypted-ota.json", import.meta.url),
  ),
);
test("encrypted OTA pin rejects unbounded or substituted archive hosts and malformed identities", () => {
  validateEncryptedOTA(spec);
  for (
    const delta of [
      { kind: "ota-delta" },
      { os: "macOS" },
      { device: "all" },
      { maximumDecryptedBytes: 100 * 1024 ** 3 },
      { archiveSha256: null },
      { url: spec.url.replace("updates.cdn-apple.com", "example.com") },
      { url: spec.url + "?key=secret" },
      { build: "unknown" },
    ]
  ) {
    assert.throws(() => validateEncryptedOTA({ ...spec, ...delta }));
  }
});
test("key selection binds URL, release and device without printing key data in errors", () => {
  const key = randomBytes(32), encoded = key.toString("base64");
  const entry = {
    url: spec.url,
    filename: new URL(spec.url).pathname.split("/").at(-1),
    version: spec.version,
    build: spec.build,
    devices: [spec.device],
    key: encoded,
  };
  assert.deepEqual(selectOTAKey([entry], spec), key);
  for (
    const entries of [
      [],
      [entry, entry],
      [{ ...entry, build: "bad" }],
      [{ ...entry, devices: [] }],
      [{ ...entry, filename: "other.aea" }],
      [{ ...entry, key: "SECRET-CONTENT" }],
    ]
  ) {
    assert.throws(() => selectOTAKey(entries, spec), (err) => {
      assert.ok(!String(err).includes(encoded));
      assert.ok(!String(err).includes("SECRET-CONTENT"));
      return true;
    });
  }
});
test(
  "native AEA decrypt uses a key file and produces bounded, hashed plaintext",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "encrypted-ota-test-"));
    const free = await statfs(root);
    if (free.bavail * free.bsize < 11 * 1024 ** 3) {
      t.skip("Native acquisition requires 10 GiB reserve");
      return;
    }
    const key = join(root, "key.bin"),
      input = join(root, "input"),
      archive = join(root, "input.aea");
    await writeFile(key, randomBytes(32), { mode: 0o600 });
    await writeFile(input, "native AEA fixture, not Apple content\n");
    execFileSync("/usr/bin/aea", [
      "encrypt",
      "-i",
      input,
      "-o",
      archive,
      "-key",
      key,
      "-profile",
      "1",
    ]);
    const result = await decryptOTAFile({
      input: archive,
      output: join(root, "out"),
      key,
      maximumBytes: 1024,
    });
    assert.deepEqual(await readFile(result.path), await readFile(input));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await writeFile(key, randomBytes(32));
    await assert.rejects(
      decryptOTAFile({
        input: archive,
        output: join(root, "bad"),
        key,
        maximumBytes: 1024,
      }),
      /subprocess output suppressed/,
    );
  },
);
test("layout probe reports only selected metadata and rejects delta or wrong builds", async () => {
  const script =
    new URL("../../scripts/collection/inspect-ota-layout.py", import.meta.url).pathname;
  const code = `import importlib.util, tempfile, zipfile, plistlib
from pathlib import Path
s=importlib.util.spec_from_file_location('layout', ${JSON.stringify(script)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=Path(d)/'a.zip'
 def make(build='23H30', prerequisite=None):
  props={'OSVersion':'26.7.1','Build':build,'ArchiveDecryptionKey':'DO_NOT_EXPOSE'}
  if prerequisite: props['PrerequisiteBuild']=prerequisite
  with zipfile.ZipFile(p,'w') as z:
   z.writestr('Info.plist',plistlib.dumps({'MobileAssetProperties':props}))
   z.writestr('AssetData/Info.plist',plistlib.dumps({'ProductVersion':'26.7.1','Build':'23H30'}))
   z.writestr('AssetData/payloadv2/image_patches/cryptex-app',b'patch')
 make();r=m.inspect(p,{'version':'26.7.1','build':'23H30'})
 assert r['status']=='full-ota-layout-inspected' and len(r['patches'])==1
 assert 'DO_NOT_EXPOSE' not in str(r)
 for args in [('bad',None),('23H30','23A1')]:
  make(*args)
  try: m.inspect(p,{'version':'26.7.1','build':'23H30'});raise AssertionError('accepted mismatch')
  except ValueError: pass
 p.write_bytes(b'not a ZIP')
 assert m.inspect(p,{})['format']=='non-zip'
`;
  execFileSync("python3", ["-B", "-c", code]);
});
test("CI retains only bounded metadata, never raw OTA or keys", async () => {
  const workflow = await readFile(
    new URL(
      "../../.github/workflows/localization-encrypted-ota.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /allow_download == true/);
  assert.match(workflow, /path: \|[\s\S]*?\/layout.json/);
  assert.doesNotMatch(workflow, /secrets\.|docker\/login|\.aea|ota_fcs_keys/);
});

test(
  "native AA01 outer OTA inspection reads metadata without materializing payload files",
  { skip: process.platform !== "darwin" },
  () => {
    const script =
      new URL("../../scripts/collection/inspect-ota-layout.py", import.meta.url).pathname;
    execFileSync("python3", [
      "-B",
      "-c",
      `
import importlib.util,tempfile,plistlib,subprocess
from pathlib import Path
s=importlib.util.spec_from_file_location('layout',${JSON.stringify(script)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=Path(d);tree=p/'tree';tree.mkdir();(tree/'AssetData').mkdir()
 (tree/'Info.plist').write_bytes(plistlib.dumps({'MobileAssetProperties':{'OSVersion':'26.7.1','Build':'23H30','ArchiveDecryptionKey':'DO_NOT_EXPOSE'}}))
 (tree/'AssetData/Info.plist').write_bytes(plistlib.dumps({'ProductVersion':'26.7.1','Build':'23H30'}))
 (tree/'AssetData/payloadv2').mkdir();(tree/'AssetData/payloadv2/payload.000').write_bytes(b'not extracted')
 a=p/'outer.aa'
 subprocess.run(['/usr/bin/aa','archive','-d',str(tree),'-o',str(a),'-a','raw'],check=True)
 r=m.inspect(a,{'version':'26.7.1','build':'23H30'})
 assert r['format']=='apple-archive' and r['regularPayloadMembers']==1
 assert 'DO_NOT_EXPOSE' not in str(r)
 normal_path=Path(${
        JSON.stringify(script)
      }).with_name('normalize-ota-archive.py')
 ns=importlib.util.spec_from_file_location('normal',normal_path);normal=importlib.util.module_from_spec(ns);ns.loader.exec_module(normal)
 normal.RESERVE=0;normal.MAX_BYTES=16*1024**2
 n1=normal.normalize(a,p/'one');n2=normal.normalize(a,p/'two')
 assert n1['sha256']==n2['sha256'] and n1['sourceFormat']=='apple-archive'
 import zipfile
 with zipfile.ZipFile(n1['path']) as z:
  assert set(z.namelist())=={'Info.plist','AssetData/Info.plist','AssetData/payloadv2/payload.000'}
  for name in z.namelist(): assert z.read(name)==(tree/name).read_bytes()
 assert m.inspect(n1['path'],{'version':'26.7.1','build':'23H30'})['format']=='zip'
 import struct
 def record(op,body):
  fields=b'TYP1M'+b'YOP1'+op+b'DATB'+struct.pack('<I',len(body))
  return b'AA01'+struct.pack('<H',len(fields)+6)+fields+body
 compressed=p/'compressed.aa'
 subprocess.run(['/usr/bin/aa','archive','-d',str(tree),'-o',str(compressed),'-a','lzma'],check=True)
 for name,body in [('raw',a.read_bytes()),('compressed',compressed.read_bytes())]:
  wrapped=p/(name+'.yop');wrapped.write_bytes(record(b'M',b'')+record(b'E',body))
  n=normal.normalize(wrapped,p/('wrap-'+name))
  assert n['sha256']==n1['sha256']
 path=b'Info.plist'
 attrs=b'TYP1F'+b'PATP'+struct.pack('<H',len(path))+path+b'MOD4'+struct.pack('<I',420)+b'SIZ4'+struct.pack('<I',(tree/'Info.plist').stat().st_size)
 fixup=b'AA01'+struct.pack('<H',len(attrs)+6)+attrs
 wrapped=p/'fixup.yop';wrapped.write_bytes(record(b'M',b'')+record(b'E',a.read_bytes())+record(b'O',fixup))
 n=normal.normalize(wrapped,p/'with-fixup')
 assert n['sha256']==n1['sha256'] and n['metadataFixups'][0]['records']==1
 assert [x.name for x in (p/'with-fixup').iterdir()]==['full-ota.zip']
 from types import SimpleNamespace
 original_usage=normal.shutil.disk_usage
 normal.MAX_BYTES=12*1024**3;normal.RESERVE=10*1024**3
 normal.shutil.disk_usage=lambda _:SimpleNamespace(free=normal.RESERVE+512*1024**2)
 assert normal.normalize(wrapped,p/'bounded-disk')['sha256']==n1['sha256']
 normal.shutil.disk_usage=lambda _:SimpleNamespace(free=normal.RESERVE-1)
 try:normal.normalize(wrapped,p/'no-reserve');raise AssertionError('reserve lowered')
 except ValueError:pass
 normal.shutil.disk_usage=original_usage;normal.RESERVE=0;normal.MAX_BYTES=16*1024**2
 dup=p/'duplicate.yop';dup.write_bytes(record(b'E',a.read_bytes())+record(b'E',a.read_bytes()))
 try:normal.normalize(dup,p/'duplicate');raise AssertionError('duplicate overwritten')
 except ValueError:pass
 for e in [{'TYP':'F','PAT':'Info.plist','DAT':1},{'TYP':'F','PAT':'../escape'},
           {'TYP':'F','PAT':'Info.plist','XAT':10},{'TYP':'L','PAT':'Info.plist','LNK':'elsewhere'}]:
  try:normal.verify_fixups([{'sha256':'test','entries':[e]}],{'Info.plist':{'bytes':1}});raise AssertionError('unsafe fixup accepted')
  except ValueError:pass
 bad=p/'unsupported.yop';bad.write_bytes(record(b'P',a.read_bytes()))
 try:normal.normalize(bad,p/'refuse-op');raise AssertionError('patch operation accepted')
 except ValueError:pass
 (tree/'link').symlink_to('Info.plist')
 subprocess.run(['/usr/bin/aa','archive','-d',str(tree),'-o',str(p/'link.aa'),'-a','raw'],check=True)
 try:normal.normalize(p/'link.aa',p/'refuse');raise AssertionError('link accepted')
 except ValueError:pass
`,
    ]);
  },
);
