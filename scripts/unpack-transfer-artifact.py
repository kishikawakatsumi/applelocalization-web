"""Bounded flat GitHub artifact extraction, after caller verifies archive digest."""
import argparse
import os
import re
import stat
import zipfile


def unpack(archive, output, kind):
    limit = 8 * 1024**2 if kind == "report" else 2 * 1024**3 + 72 * 1024**2
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        assert 0 < len(entries) <= 20002, "Invalid entry count"
        names = set()
        for e in entries:
            assert e.filename not in names, "Duplicate entry"
            names.add(e.filename)
            assert (e.filename == "report.json" if kind == "report" else
                    e.filename == "transport.json" or re.fullmatch(r"[0-9]{6}\.age", e.filename)), "Unexpected ZIP path"
            mode = e.external_attr >> 16
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG), "Not a regular ZIP entry"
            assert not e.flag_bits & 1, "Encrypted ZIP not supported"
        assert (names == {"report.json"} if kind == "report" else "transport.json" in names)
        assert sum(e.file_size for e in entries) <= limit, "Unpacked size exceeds budget"
        os.mkdir(output, 0o700)
        total = 0
        for e in entries:
            count = 0
            with z.open(e) as src, open(os.path.join(output, e.filename), "xb") as dest:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    total += len(chunk)
                    assert count <= e.file_size and total <= limit, "ZIP exceeded declared size"
                    dest.write(chunk)
            assert count == e.file_size, "Truncated ZIP entry"


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--archive", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--kind", required=True, choices=["report", "sealed"])
    a = p.parse_args()
    unpack(a.archive, a.output, a.kind)
