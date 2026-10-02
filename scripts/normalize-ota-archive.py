"""Rewrap regular outer AA01 members into deterministic ZIP, never an OS install."""
import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

s = importlib.util.spec_from_file_location("layout", Path(__file__).with_name("inspect-ota-layout.py"))
layout = importlib.util.module_from_spec(s)
s.loader.exec_module(layout)
MAX_BYTES = 12 * 1024**3
RESERVE = 10 * 1024**3


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024**2), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize(archive, output):
    archive, output = Path(archive), Path(output)
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > MAX_BYTES:
        raise ValueError("Unsafe or oversized input")
    with archive.open("rb") as f:
        if f.read(4) != b"AA01":
            raise ValueError("Expected uncompressed AA01 outer OTA")
    files = layout.aa_entries(archive)
    total = sum(e["bytes"] for e in files.values())
    if not files or len(files) > 100000 or total > MAX_BYTES:
        raise ValueError("Outer OTA member budget exceeded")
    output.mkdir()
    if shutil.disk_usage(output).free < RESERVE + 2 * total + 128 * 1024**2:
        raise ValueError("Insufficient space to normalize OTA with 10 GiB reserve")
    target = output / "full-ota.zip"
    with tempfile.TemporaryDirectory(prefix="outer-members-", dir=output) as tmp:
        subprocess.run(["/usr/bin/aa", "extract", "-i", str(archive), "-d", tmp,
                        "-include-type", "f", "-exclude-field", "all", "-include-field", "typ,pat,dat"],
                       check=True, capture_output=True, timeout=1200)
        actual = {}
        for p in Path(tmp).rglob("*"):
            if p.is_symlink() or not (p.is_file() or p.is_dir()):
                raise ValueError("Unexpected nonregular extracted member")
            if p.is_file():
                actual[p.relative_to(tmp).as_posix()] = p
        if set(actual) != set(files):
            raise ValueError("Apple Archive extraction member mismatch")
        for name, path in actual.items():
            if path.stat().st_size != files[name]["bytes"]:
                raise ValueError("Apple Archive extraction byte mismatch")
        # No timestamps, ownership or host metadata enter the derived ZIP identity.
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
            for name in sorted(files):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                with actual[name].open("rb") as src, z.open(entry, "w", force_zip64=True) as dst:
                    while chunk := src.read(4 * 1024**2):
                        if shutil.disk_usage(output).free < RESERVE:
                            raise ValueError("Free disk reserve exhausted")
                        dst.write(chunk)
    return {"status": "outer-ota-rewrapped", "format": "zip", "sourceFormat": "apple-archive",
            "sourceSha256": sha(archive), "path": str(target), "bytes": target.stat().st_size,
            "sha256": sha(target), "members": len(files), "memberBytes": total}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--archive", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    print(json.dumps(normalize(a.archive, a.output)))
