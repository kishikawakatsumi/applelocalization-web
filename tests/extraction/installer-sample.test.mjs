import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";

const setup = `
import importlib.util
spec = importlib.util.spec_from_file_location("sample", "scripts/extraction/extract-installer-sample.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
bundle = "System/Library/Frameworks/Contacts.framework"
path = bundle + "/Versions/A/Resources/Info.plist"
`;
const python = (code) =>
  execFileSync("python3", ["-B", "-c", setup + code], {
    encoding: "utf8",
  });

test("installer sample rejects escaping and ambiguous archive paths", () => {
  assert.equal(
    python(`
for path in ["", "/absolute", "a//b", "a/../b", "./a", "a/", "a\\\\b", "a\\0b"]:
    try: m.safe_path(path)
    except ValueError: pass
    else: raise AssertionError(path)
assert m.safe_path("System/Library/file") == "System/Library/file"
`),
    "",
  );
});

test("installer sample records but never selects links for materialization", () => {
  python(`
file = {"PAT": path, "TYP": "F", "DAT": 12}
entries = [file, {"PAT": bundle, "TYP": "D"},
           {"PAT": bundle + "/Resources", "TYP": "L", "LNK": "/host/path"},
           {"PAT": bundle + "/Hard", "TYP": "H"}]
assert m.validate_entries(entries, bundle) == [file]
assert m.validate_entries([], bundle) == []
`);
});

test("installer sample rejects duplicates, unsupported data and scope escapes", () => {
  python(`
file = {"PAT": path, "TYP": "F", "DAT": 12}
for entries in [[file, file], [{"PAT": "etc/passwd", "TYP": "F", "DAT": 1}],
                [{"PAT": path, "TYP": "F"}], [{"PAT": path, "TYP": "F", "DAT": -1}],
                [{"PAT": path, "TYP": "F", "DAT": True}],
                [{"PAT": path, "TYP": "F", "DAT": m.MAX_BYTES + 1}],
                [{"PAT": path, "TYP": "P"}], {}]:
    try: m.validate_entries(entries, bundle)
    except ValueError: pass
    else: raise AssertionError(entries)
`);
});

test("installer sample limits aggregate bytes, not only individual files", () => {
  python(`
try:
    m.validate_entries([{"PAT": path, "TYP": "F", "DAT": m.MAX_BYTES},
                        {"PAT": bundle + "/second", "TYP": "F", "DAT": 1}], bundle)
except ValueError: pass
else: raise AssertionError("Budget not enforced")
`);
});

test("installer sample rejects symlinks in materialized output", () => {
  python(`
import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix="installer-sample-test-") as tmp:
    root = Path(tmp)
    (root / "file").write_text("test")
    assert list(m.actual_files(root)) == ["file"]
    (root / "escape").symlink_to("/tmp", target_is_directory=True)
    try: m.actual_files(root)
    except ValueError: pass
    else: raise AssertionError("Symlink accepted")
`);
});

test("installer link mappings keep every destination and resolve explicit chains", () => {
  python(`
links = m.parse_links("=shared/file\\n+bundle/en/file\\n+bundle/ja/file\\n=bundle/en/file\\n+third/file\\n")
assert len(links) == 3
source, chain = m.link_source("third/file", links)
assert source == "shared/file" and len(chain) == 2
assert links["bundle/en/file"] == links["bundle/ja/file"]
assert m.validate_entries([{"PAT": "shared/file", "TYP": "F", "DAT": 2}], bundle, {"shared/file"})
`);
});

test("installer link definitions reject escapes, duplicates, cycles and unknown syntax", () => {
  python(`
for text in ["+orphan\\n", "=../outside\\n+dest\\n", "=src\\n+/absolute\\n",
             "=src\\n+dest\\n=other\\n+dest\\n", "=same\\n+same\\n", "?unknown\\n"]:
    try: m.parse_links(text)
    except ValueError: pass
    else: raise AssertionError(text)
try: m.link_source("a", {"a": "b", "b": "a"})
except ValueError: pass
else: raise AssertionError("Cycle accepted")
`);
});

test(
  "native installer sample restores duplicate paths and matches an independent BOM",
  {
    skip: process.platform !== "darwin",
  },
  () => {
    python(`
import tempfile, pathlib, plistlib, subprocess, zipfile, json, shutil
with tempfile.TemporaryDirectory(prefix="installer-sample-native-") as tmp:
    base = pathlib.Path(tmp)
    payload = base / "payload"
    full = base / "expected"
    payload.mkdir()
    regular = {
        m.SYSTEM_VERSION: plistlib.dumps({"ProductVersion":"15.8.1", "ProductBuildVersion":"24H32"}),
        path: plistlib.dumps({"CFBundleIdentifier":"test.contacts"}),
        "Shared/label": b"same bytes in distinct language contexts",
    }
    for name, data in regular.items():
        p = payload / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    shutil.copytree(payload, full)
    destinations = [bundle + "/Versions/A/Resources/en.lproj/Localizable.strings",
                    bundle + "/Versions/A/Resources/ja.lproj/Localizable.strings"]
    for name in destinations:
        p = full / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(regular["Shared/label"])
    subprocess.run(["/usr/bin/aa", "archive", "-d", str(payload), "-o", str(base / "payload.000")], check=True)
    subprocess.run(["/usr/bin/mkbom", str(full), str(base / "post.bom")], check=True)
    archive = base / "fixture.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("Info.plist", plistlib.dumps({"MobileAssetProperties":{"OSVersion":"15.8.1", "Build":"24H32"}}))
        z.writestr("AssetData/Info.plist", plistlib.dumps({"ProductVersion":"15.8.1", "Build":"24H32"}))
        z.writestr("AssetData/payloadv2/links.txt", "=Shared/label\\n" + "".join("+" + d + "\\n" for d in destinations))
        z.write(base / "post.bom", "AssetData/post.bom")
        z.write(base / "payload.000", "AssetData/payloadv2/payload.000")
    out = base / "output"
    m.extract(archive, out, "15.8.1", "24H32", bundle)
    report = json.loads((out / "result.json").read_text())
    assert report["files"] == 4 and report["linksRestored"] == 2
    assert report["dependencyOnly"] == ["Shared/label"]
    origins = json.loads((out / "origins.json").read_text())
    assert all((out / "selected-tree" / d).read_bytes() == regular["Shared/label"] for d in destinations)
    assert all(not (out / "selected-tree" / d).is_symlink() for d in destinations)
    assert origins[destinations[0]]["sha256"] == origins[destinations[1]]["sha256"]
    assert origins[destinations[0]]["linkChain"] != origins[destinations[1]]["linkChain"]
    try: m.extract(archive, out, "15.8.1", "24H32", bundle)
    except FileExistsError: pass
    else: raise AssertionError("Existing output overwritten")
`);
  },
);
