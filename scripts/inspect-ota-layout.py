"""Bounded metadata report only: never emit original plist contents or keys."""
import argparse
import hashlib
import json
import plistlib
import stat
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path


def aa_entries(archive):
    # A full OTA outer archive has few entries; do not allow unbounded tool output.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(["/usr/bin/aa", "list", "-i", str(archive), "-list-format", "json"], stdout=out, stderr=err)
        try:
            p.wait(timeout=120)
            if p.returncode or out.tell() > 64 * 1024**2:
                raise ValueError("Apple Archive listing failed or exceeded metadata bound")
            out.seek(0)
            entries = json.load(out)
        finally:
            if p.poll() is None:
                p.kill(); p.wait()
    if not isinstance(entries, list):
        raise ValueError("Invalid Apple Archive listing")
    files, seen = {}, set()
    for e in entries:
        if e["TYP"] == "M":
            continue
        name = e["PAT"]
        if e["TYP"] == "D" and name in ("", ".", "./"):
            continue
        if name.startswith("./"):
            name = name[2:]
        if not name or name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/")) or "\\" in name or "\n" in name:
            raise ValueError("Unsafe Apple Archive path")
        if name in seen:
            raise ValueError("Duplicate Apple Archive path")
        seen.add(name)
        if e["TYP"] == "D":
            continue
        if e["TYP"] != "F" or type(e.get("DAT")) is not int or e["DAT"] < 0:
            raise ValueError("Only regular outer-OTA files are supported")
        files[name] = {"member": name, "bytes": e["DAT"], "regular": True}
    return files


def aa_metadata(archive, entries):
    names = ("Info.plist", "AssetData/Info.plist")
    for n in names:
        if n not in entries or entries[n]["bytes"] > 4 * 1024**2:
            raise ValueError("Missing or oversized Apple Archive metadata")
    with tempfile.TemporaryDirectory() as d:
        expr = "^(\\./)?(" + "|".join(re.escape(n) for n in names) + ")$"
        subprocess.run(["/usr/bin/aa", "extract", "-i", str(archive), "-d", d,
                        "-include-regex", expr, "-include-type", "f", "-exclude-field", "all",
                        "-include-field", "typ,pat,dat"], check=True, capture_output=True, timeout=120)
        actual = set()
        for p in Path(d).rglob("*"):
            if p.is_symlink():
                raise ValueError("Unexpected metadata symlink")
            if p.is_file():
                actual.add(p.relative_to(d).as_posix())
        if actual != set(names):
            raise ValueError("Metadata extraction path mismatch")
        return {n: (Path(d) / n).read_bytes() for n in names}


def report_metadata(raws, files, spec, format):
    hashes = {n: hashlib.sha256(raw).hexdigest() for n, raw in raws.items()}
    data = {n: plistlib.loads(raw) for n, raw in raws.items()}
    props, info = data["Info.plist"]["MobileAssetProperties"], data["AssetData/Info.plist"]
    if props["Build"] != spec["build"] or info["Build"] != spec["build"]:
        raise ValueError("Internal build mismatch")
    if props["OSVersion"] not in (spec["version"], "9.9." + spec["version"]) or info["ProductVersion"] != spec["version"]:
        raise ValueError("Internal version mismatch")
    if props.get("PrerequisiteBuild") or info.get("PrerequisiteBuild"):
        raise ValueError("Full OTA required")
    return {"status": "full-ota-layout-inspected", "format": format, "version": spec["version"],
            "build": spec["build"], "otaVersion": props["OSVersion"], "metadataHashes": hashes,
            "members": len(files),
            "patches": [v for n, v in files.items() if n.startswith("AssetData/payloadv2/image_patches/")],
            "regularPayloadMembers": sum(n.startswith("AssetData/payloadv2/payload.") for n in files)}

def inspect(archive, spec):
    if not zipfile.is_zipfile(archive):
        with open(archive, "rb") as f:
            prefix = f.read(16).hex()
        if prefix.startswith("41413031"):
            entries = aa_entries(archive)
            return report_metadata(aa_metadata(archive, entries), entries, spec, "apple-archive")
        return {"status": "unsupported-decrypted-ota-format", "format": "non-zip", "prefixHex": prefix}
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate OTA ZIP members")
        hashes, data = {}, {}
        for name in ("Info.plist", "AssetData/Info.plist"):
            entry = z.getinfo(name)
            if entry.file_size > 4 * 1024**2:
                raise ValueError("Metadata exceeds bound")
            raw = z.read(name)
            hashes[name] = hashlib.sha256(raw).hexdigest()
            data[name] = plistlib.loads(raw)
        props, info = data["Info.plist"]["MobileAssetProperties"], data["AssetData/Info.plist"]
        if props["Build"] != spec["build"] or info["Build"] != spec["build"]:
            raise ValueError("Internal build mismatch")
        if props["OSVersion"] not in (spec["version"], "9.9." + spec["version"]) or info["ProductVersion"] != spec["version"]:
            raise ValueError("Internal version mismatch")
        if props.get("PrerequisiteBuild") or info.get("PrerequisiteBuild"):
            raise ValueError("Full OTA required")
        patches = []
        for entry in z.infolist():
            if entry.filename.startswith("AssetData/payloadv2/image_patches/") and not entry.is_dir():
                patches.append({"member": entry.filename, "bytes": entry.file_size,
                                "regular": stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)})
        return {"status": "full-ota-layout-inspected", "format": "zip", "version": spec["version"],
                "build": spec["build"], "otaVersion": props["OSVersion"], "metadataHashes": hashes,
                "members": len(names), "patches": patches,
                "regularPayloadMembers": sum(n.startswith("AssetData/payloadv2/payload.") for n in names)}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--archive", required=True)
    p.add_argument("--spec", required=True)
    a = p.parse_args()
    print(json.dumps(inspect(a.archive, json.loads(Path(a.spec).read_text()))))
