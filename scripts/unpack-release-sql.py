"""Extract only a caller-pinned SQL/receipt layout from a verified Release ZIP."""
import argparse
import json
import os
from pathlib import PurePosixPath
import stat
import zipfile


def unpack(archive, output, files):
    allowed = set(files)
    assert len(allowed) == len(files) and 0 < len(files) <= 500
    parents = set()
    for name in files:
        path = PurePosixPath(name)
        assert not path.is_absolute() and str(path) == name
        assert all(p not in (".", "..") for p in path.parts) and "\\" not in name
        parents.update(str(p) for p in path.parents if str(p) != ".")
    with zipfile.ZipFile(archive) as z:
        members, seen, total = [], set(), 0
        for entry in z.infolist():
            assert entry.filename not in seen, "Duplicate ZIP member"
            seen.add(entry.filename)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            assert not entry.flag_bits & 1, "Encrypted ZIP member"
            if entry.is_dir():
                assert entry.filename[:-1] in parents and mode in (0, stat.S_IFDIR)
                continue
            assert entry.filename in allowed, "Unexpected ZIP path"
            assert mode in (0, stat.S_IFREG), "Links/special files are forbidden"
            total += entry.file_size
            assert total < 3 * 1024**3, "ZIP expansion exceeds budget"
            members.append(entry)
        assert {e.filename for e in members} == allowed, "Missing ZIP files"
        os.mkdir(output, 0o700)
        for parent in sorted(parents, key=lambda p: (p.count("/"), p)):
            os.mkdir(os.path.join(output, parent), 0o700)
        for entry in members:
            count = 0
            with z.open(entry) as src, open(os.path.join(output, entry.filename), "xb") as dest:
                while True:
                    data = src.read(1024 * 1024)
                    if not data:
                        break
                    count += len(data)
                    assert count <= entry.file_size
                    dest.write(data)
            assert count == entry.file_size


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--archive", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--files", required=True)
    args = p.parse_args()
    unpack(args.archive, args.output, json.loads(args.files))
