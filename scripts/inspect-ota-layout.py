"""Bounded metadata report only: never emit original plist contents or keys."""
import argparse
import hashlib
import json
import plistlib
import stat
import zipfile
from pathlib import Path


def inspect(archive, spec):
    if not zipfile.is_zipfile(archive):
        with open(archive, "rb") as f:
            prefix = f.read(16).hex()
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
