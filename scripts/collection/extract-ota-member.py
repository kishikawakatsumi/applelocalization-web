"""Validate pinned full-OTA metadata; optionally extract one regular cryptex patch."""
import argparse
import hashlib
import json
import plistlib
import shutil
import stat
import zipfile
from pathlib import Path


def extract(archive, spec, output):
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate OTA ZIP member")
        saved = {}
        for name, expected in spec["metadataHashes"].items():
            if name not in ("Info.plist", "AssetData/Info.plist") or z.getinfo(name).file_size > 4*1024**2:
                raise ValueError("Invalid OTA metadata member")
            raw = z.read(name)
            if hashlib.sha256(raw).hexdigest() != expected:
                raise ValueError("Pinned OTA metadata changed")
            saved[name] = plistlib.loads(raw)
        props = saved["Info.plist"]["MobileAssetProperties"]
        info = saved["AssetData/Info.plist"]
        if (props["OSVersion"], props["Build"], info["ProductVersion"], info["Build"]) != (
                spec["otaVersion"], spec["build"], spec["version"], spec["build"]):
            raise ValueError("OTA internal version/build mismatch")
        if props.get("PrerequisiteBuild") or info.get("PrerequisiteBuild"):
            raise ValueError("Delta OTA is not a full source")
        member = spec["member"]
        result = {"status": "full-ota-metadata-verified", "member": member}
        if member is not None:
            allowed = ["cryptex-app", "cryptex-system-arm64e", "cryptex-system-x86_64"]
            if member not in ["AssetData/payloadv2/image_patches/"+c for c in allowed]:
                raise ValueError("Unexpected OTA patch path")
            entry = z.getinfo(member)
            if entry.file_size != spec["memberBytes"] or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG):
                raise ValueError("Patch size/type mismatch")
            path = Path(output) / member.rsplit("/", 1)[1]
            with z.open(entry) as src, path.open("xb") as dest:
                while chunk := src.read(4*1024**2):
                    if shutil.disk_usage(output).free < 10*1024**3:
                        raise ValueError("Insufficient free disk reserve")
                    dest.write(chunk)
            result.update(path=str(path), bytes=path.stat().st_size)
        return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    for key in ("archive", "spec", "output"):
        p.add_argument("--"+key, required=True)
    a = p.parse_args()
    print(json.dumps(extract(a.archive, json.loads(Path(a.spec).read_text()), a.output)))
