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
} from "../scripts/acquire-encrypted-ota.mjs";
const spec = JSON.parse(
  await readFile(
    new URL("../scripts/ios26-encrypted-ota.json", import.meta.url),
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
    new URL("../scripts/inspect-ota-layout.py", import.meta.url).pathname;
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
      "../.github/workflows/localization-encrypted-ota.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /allow_download == true/);
  assert.match(workflow, /path: .*\/layout.json/);
  assert.doesNotMatch(workflow, /secrets\.|docker\/login|\.aea|ota_fcs_keys/);
});
