import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";

const setup = `
import importlib.util, pathlib, tempfile, plistlib, subprocess, zipfile, json, shutil
spec = importlib.util.spec_from_file_location("resources", "scripts/extraction/extract-installer-resources.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
const python = (code) =>
  execFileSync("python3", ["-B", "-c", setup + code], {
    encoding: "utf8",
    timeout: 120000,
  });

test("installer resource scope includes all locales and opaque localized files", () => {
  assert.equal(
    python(`
for p in ["a/ja.lproj/view.nib", "a/xx.lproj/asset.png", "a/Localizable.xcstrings",
          "a/Info.plist", "a/version.plist", "a.strings", "b.loctable", "c.stringsdict"]:
    assert m.selected(p), p
for p in ["bin/executable", "notlproj/file", "foo.strings.bak"]:
    assert not m.selected(p), p
assert m.inventory("./a.strings\\t4\\n") == {"a.strings": 4}
for text in ["../x\\t1", "a\\t1\\na\\t1", "a\\t-1"]:
    try: m.inventory(text)
    except ValueError: pass
    else: raise AssertionError(text)
for entry in [{"PAT":"a.strings", "TYP":"F", "DAT":True},
              {"PAT":"a.strings", "TYP":"F", "DAT":2},
              {"PAT":"../escape", "TYP":"F", "DAT":1},
              {"PAT":"outside", "TYP":"F", "DAT":1}]:
    try: m.validate_entries([entry], {"a.strings":1})
    except ValueError: pass
    else: raise AssertionError(entry)
`),
    "",
  );
});

const fixture = `
audit_spec = importlib.util.spec_from_file_location("resource_audit", "scripts/extraction/audit-installer-resources.py")
auditor = importlib.util.module_from_spec(audit_spec)
audit_spec.loader.exec_module(auditor)
def make(base, missing=False):
    full = base / "expected"
    full.mkdir()
    bundle = "System/Library/Frameworks/Test.framework/Versions/A/Resources/"
    data = {m.sample.SYSTEM_VERSION: plistlib.dumps({"ProductVersion":"15.8.1", "ProductBuildVersion":"24H32"}),
            bundle + "Info.plist": plistlib.dumps({"CFBundleIdentifier":"test.bundle"}),
            "Shared/label": b"shared bytes",
            bundle + "other.loctable": plistlib.dumps({"key":{"en":"A","ja":"B"}})}
    dests = [bundle + "en.lproj/Localizable.strings", bundle + "ja.lproj/Localizable.strings"]
    for path, value in {**data, **dict.fromkeys(dests, b"shared bytes")}.items():
        p = full / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(value)
    subprocess.run(["/usr/bin/mkbom", str(full), str(base / "post.bom")], check=True)
    archive = base / "fixture.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("Info.plist", plistlib.dumps({"MobileAssetProperties":{"OSVersion":"15.8.1","Build":"24H32"}}))
        z.writestr("AssetData/Info.plist", plistlib.dumps({"ProductVersion":"15.8.1","Build":"24H32"}))
        z.writestr("AssetData/payloadv2/links.txt", "=Shared/label\\n" + "".join("+" + d + "\\n" for d in dests))
        z.write(base / "post.bom", "AssetData/post.bom")
        for index, subset in enumerate([list(data.items())[:2], list(data.items())[2:]]):
            root = base / ("part" + str(index))
            root.mkdir()
            for path, value in subset:
                if missing and path.endswith("other.loctable"): continue
                p = root / path
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(value)
            aa = base / ("payload.%03d" % index)
            subprocess.run(["/usr/bin/aa", "archive", "-d", str(root), "-o", str(aa)], check=True)
            z.write(aa, "AssetData/payloadv2/" + aa.name)
    return archive, dests
`;

test("installer resume rejects concurrent writers and symlink output", () => {
  python(`
import fcntl
with tempfile.TemporaryDirectory(prefix="installer-resources-lock-") as tmp:
    base = pathlib.Path(tmp)
    output = base / "output"
    output.mkdir()
    with (output / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try: m.extract(base / "absent.zip", output, "15.8.1", "24H32", resume=True)
        except BlockingIOError: pass
        else: raise AssertionError("Concurrent writer accepted")
    alias = base / "alias"
    alias.symlink_to(output, target_is_directory=True)
    try: m.extract(base / "absent.zip", alias, "15.8.1", "24H32", resume=True)
    except ValueError: pass
    else: raise AssertionError("Symlink output accepted")
`);
});

test(
  "native full-scope projection resumes checkpoints and rejects corruption and input changes",
  {
    skip: process.platform !== "darwin",
  },
  () => {
    python(
      fixture + `
with tempfile.TemporaryDirectory(prefix="installer-resources-") as tmp:
    base = pathlib.Path(tmp)
    archive, dests = make(base)
    out = base / "out"
    first = m.extract(archive, out, "15.8.1", "24H32", stop_after=1)
    assert first["status"] == "paused-after-payload-checkpoint"
    checkpoint = next((out / "parts").glob("*/attempt-*/complete.json"))
    original_mtime = checkpoint.stat().st_mtime_ns
    # An incomplete attempt is preserved and never mistaken for a checkpoint.
    failed = out / "parts/payload.001/attempt-interrupted"
    failed.mkdir(parents=True)
    (failed / "entries.json").write_text("incomplete")
    result = m.extract(archive, out, "15.8.1", "24H32", resume=True)
    assert result["reusedPayloads"] == 1 and result["files"] == 5 and result["linksRestored"] == 2
    assert checkpoint.stat().st_mtime_ns == original_mtime and failed.exists()
    tree = pathlib.Path(result["tree"])
    assert all((tree / p).read_bytes() == b"shared bytes" for p in dests)
    assert not (tree / "Shared/label").exists()
    origins = json.loads((tree.parent / "origins.json").read_text())
    assert origins[dests[0]]["linkChain"] != origins[dests[1]]["linkChain"]
    audited = auditor.audit(tree.parent)
    assert audited["files"] == 5 and audited["linksRestored"] == 2
    assert audited["localizedDirectoryNames"] == ["en", "ja"]
    again = m.extract(archive, out, "15.8.1", "24H32", resume=True)
    assert again["reusedPayloads"] == 2
    with zipfile.ZipFile(archive, "a") as z: z.writestr("changed", b"changed")
    try: m.extract(archive, out, "15.8.1", "24H32", resume=True)
    except ValueError as e: assert "changed" in str(e)
    else: raise AssertionError("Changed input accepted")
    record = json.loads(checkpoint.read_text())
    path = next(iter(record["files"]))
    (checkpoint.parent / "files" / path).write_bytes(b"corrupt")
    try: m.verify_files(checkpoint.parent / "files", record["files"])
    except ValueError: pass
    else: raise AssertionError("Changed checkpoint accepted")
    try: auditor.audit(tree.parent)
    except ValueError: pass
    else: raise AssertionError("Auditor accepted changed payload")
`,
    );
  },
);

test(
  "native projection refuses missing BOM resources without reporting success",
  {
    skip: process.platform !== "darwin",
  },
  () => {
    python(
      fixture + `
with tempfile.TemporaryDirectory(prefix="installer-resources-missing-") as tmp:
    base = pathlib.Path(tmp)
    archive, dests = make(base, missing=True)
    out = base / "out"
    try: m.extract(archive, out, "15.8.1", "24H32")
    except ValueError as e: assert "differ from BOM" in str(e)
    else: raise AssertionError("Missing resource accepted")
    comparison = json.loads(next((out / "runs").glob("*/bom-comparison.json")).read_text())
    assert len(comparison["missing"]) == 1
    assert not list((out / "runs").glob("*/selected-tree"))
`,
    );
  },
);
