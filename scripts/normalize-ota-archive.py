"""Rewrap regular outer AA01 members into deterministic ZIP, never an OS install."""
import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import struct
import tempfile
import zipfile
from pathlib import Path

s = importlib.util.spec_from_file_location("layout", Path(__file__).with_name("inspect-ota-layout.py"))
layout = importlib.util.module_from_spec(s)
s.loader.exec_module(layout)
MAX_BYTES = 12 * 1024**3
RESERVE = 10 * 1024**3


def yop_header(f):
    prefix = f.read(6)
    if not prefix:
        return None
    if len(prefix) != 6 or prefix[:4] != b"AA01":
        raise ValueError("Invalid YOP record header")
    length = struct.unpack("<H", prefix[4:])[0]
    if length < 6:
        raise ValueError("Invalid YOP header size")
    raw = f.read(length - 6)
    if len(raw) != length - 6:
        raise ValueError("Truncated YOP header")
    fields, offset = {}, 0
    while offset < len(raw):
        if offset + 4 > len(raw):
            raise ValueError("Truncated YOP field")
        name = raw[offset:offset+3].decode("ascii")
        kind = chr(raw[offset+3]); offset += 4
        if name in fields:
            raise ValueError("Duplicate YOP field")
        if name in ("TYP", "YOP") and kind == "1":
            size = 1
        elif name == "DAT" and kind in "ABC":
            size = {"A": 2, "B": 4, "C": 8}[kind]
        elif name in ("SIZ", "IDX", "IDZ") and kind in "1248":
            size = int(kind)
        elif name in ("PAT", "LBL") and kind == "P":
            if offset + 2 > len(raw):
                raise ValueError("Truncated YOP string size")
            size = int.from_bytes(raw[offset:offset+2], "little"); offset += 2
        else:
            raise ValueError("Unsupported YOP field: " + name + kind)
        if offset + size > len(raw):
            raise ValueError("Truncated YOP value")
        value = raw[offset:offset+size]; offset += size
        fields[name] = value.decode("ascii") if name in ("TYP", "YOP") else int.from_bytes(value, "little") if name in ("DAT", "SIZ", "IDX", "IDZ") else value
    if fields.get("TYP") != "M" or fields.get("YOP") not in ("M", "E", "O") or "DAT" not in fields:
        raise ValueError("Only full-OTA manifest/extract operations are supported")
    return fields


def convert_segment(src, length, output):
    # Native aa converts both raw AA and PBZX payload streams; no whole-chunk RAM copy.
    with tempfile.TemporaryFile() as err:
        p = subprocess.Popen(["/usr/bin/aa", "convert", "-o", str(output), "-a", "raw"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err)
        try:
            remaining = length
            while remaining:
                chunk = src.read(min(4 * 1024**2, remaining))
                if not chunk:
                    raise ValueError("Truncated YOP payload")
                if shutil.disk_usage(output.parent).free < RESERVE:
                    raise ValueError("YOP conversion free disk reserve exhausted")
                if output.exists() and output.stat().st_size > MAX_BYTES:
                    raise ValueError("YOP converted payload exceeds bound")
                p.stdin.write(chunk); remaining -= len(chunk)
            p.stdin.close()
            p.wait(timeout=1200)
            if p.returncode or not output.is_file() or output.stat().st_size > MAX_BYTES:
                raise ValueError("Native YOP segment conversion failed")
        finally:
            if p.poll() is None:
                p.kill(); p.wait()


def materialize(archive, work, files, fixups, zipped, depth=0):
    if depth > 4:
        raise ValueError("Nested YOP limit exceeded")
    records = layout.aa_records(archive)
    operations = [e for e in records if "YOP" in e]
    if operations:
        if len(operations) != len(records) or len(operations) > 1024:
            raise ValueError("Mixed or excessive YOP records")
        with Path(archive).open("rb") as src:
            for expected in operations:
                h = yop_header(src)
                if h is None or (h["TYP"], h["YOP"], h["DAT"]) != (expected["TYP"], expected["YOP"], expected["DAT"]):
                    raise ValueError("Native/header YOP inventory mismatch")
                if h["DAT"] > MAX_BYTES or src.tell() + h["DAT"] > Path(archive).stat().st_size:
                    raise ValueError("YOP segment exceeds archive bounds")
                if h["YOP"] == "M":
                    src.seek(h["DAT"], 1)
                else:
                    with tempfile.TemporaryDirectory(prefix="yop-", dir=work) as d:
                        flat = Path(d) / "flat.aa"
                        convert_segment(src, h["DAT"], flat)
                        if h["YOP"] == "O":
                            fixups.append({"sha256": sha(flat), "entries": layout.aa_records(flat)})
                        else:
                            materialize(flat, work, files, fixups, zipped, depth + 1)
            if src.read(1):
                raise ValueError("Unlisted trailing YOP record")
        return
    entries = layout.aa_entries(archive)
    if set(files) & set(entries):
        raise ValueError("Duplicate member across YOP chunks")
    files.update(entries)
    total = sum(e["bytes"] for e in files.values())
    if len(files) > 100000 or total > MAX_BYTES:
        raise ValueError(f"Outer OTA member budget exceeded: files={len(files)}, bytes={total}")
    needed = 2 * sum(e["bytes"] for e in entries.values()) + 128 * 1024**2
    free = shutil.disk_usage(work).free
    if free < RESERVE + needed:
        raise ValueError(f"Insufficient per-segment space: available={free}, required={RESERVE + needed}")
    with tempfile.TemporaryDirectory(prefix="outer-members-", dir=work) as tmp:
        subprocess.run(["/usr/bin/aa", "extract", "-i", str(archive), "-d", tmp,
                        "-include-type", "f", "-exclude-field", "all", "-include-field", "typ,pat,dat"],
                       check=True, capture_output=True, timeout=1200)
        actual = {}
        for p in Path(tmp).rglob("*"):
            if p.is_symlink() or not (p.is_file() or p.is_dir()):
                raise ValueError("Unexpected nonregular extracted member")
            if p.is_file():
                actual[p.relative_to(tmp).as_posix()] = p
        if set(actual) != set(entries):
            raise ValueError("Apple Archive extraction member mismatch")
        for name, path in actual.items():
            if path.stat().st_size != entries[name]["bytes"]:
                raise ValueError("Apple Archive extraction byte mismatch")
        # Source chunk order and sorted members are deterministic. Release each
        # temporary chunk after appending; never hold a full extracted outer tree.
        for name in sorted(entries):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            with actual[name].open("rb") as src, zipped.open(entry, "w", force_zip64=True) as dst:
                while chunk := src.read(4 * 1024**2):
                    if shutil.disk_usage(work).free < RESERVE:
                        raise ValueError("Free disk reserve exhausted")
                    dst.write(chunk)


def verify_fixups(fixups, files):
    # O only augments attributes of already extracted objects. Never create files,
    # change paths/links or accept data/xattrs through this metadata-only path.
    allowed = {"TYP", "PAT", "UID", "GID", "MOD", "FLG", "MTM", "BTM", "CTM", "SIZ", "DAT", "IDX", "IDZ"}
    directories = {"", ".", "./"}
    for name in files:
        directories.update(str(p) for p in Path(name).parents)
    reports = []
    for group in fixups:
        for entry in group["entries"]:
            if set(entry) - allowed or entry.get("TYP") not in ("F", "D") or entry.get("DAT", 0) != 0:
                raise ValueError("Fixup contains data, unsupported attributes or object type; fields=" + ",".join(sorted(entry)))
            name = entry["PAT"]
            if name.startswith("./"):
                name = name[2:]
            if entry["TYP"] == "F":
                if name not in files or ("SIZ" in entry and entry["SIZ"] != files[name]["bytes"]):
                    raise ValueError("Fixup does not match an extracted file")
            elif name not in directories:
                raise ValueError("Fixup does not match an extracted directory")
        reports.append({"sha256": group["sha256"], "records": len(group["entries"]),
                        "fields": sorted(set(k for e in group["entries"] for k in e))})
    return reports


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
    output.mkdir()
    if shutil.disk_usage(output).free < RESERVE + 128 * 1024**2:
        raise ValueError("Insufficient space to normalize OTA with 10 GiB reserve")
    target = output / "full-ota.zip"
    files, fixups = {}, []
    with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
        materialize(archive, output, files, fixups, z)
        fixup_report = verify_fixups(fixups, files)
        total = sum(e["bytes"] for e in files.values())
        if not files:
            raise ValueError("Outer OTA has no regular members")
    return {"status": "outer-ota-rewrapped", "format": "zip", "sourceFormat": "apple-archive",
            "sourceSha256": sha(archive), "path": str(target), "bytes": target.stat().st_size,
            "sha256": sha(target), "members": len(files), "memberBytes": total,
            "metadataFixups": fixup_report}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--archive", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    print(json.dumps(normalize(a.archive, a.output)))
