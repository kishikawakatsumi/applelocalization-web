"""Extract the fixed parsed-only release layout into a new directory; no raw files."""
import argparse
import os
import tarfile

FILES = {"release.json", "package/report.json", "package/catalog.json"}
FILES.update("package/" + n + ".jsonl.gz" for n in ("sources", "resources", "tables", "occurrences", "issues", "symlinks"))
FILES.update("evidence/" + n for n in ("package.complete.json", "package-audit.complete.json", "audit.json", "transfer-manifest.json"))
DIRS = {"package", "evidence"}


def unpack(archive, output):
    with tarfile.open(archive, "r:") as tar:
        members = []
        names = set()
        total = 0
        for entry in tar:
            assert entry.name not in names, "Duplicate tar member"
            names.add(entry.name)
            assert (entry.name in DIRS and entry.isdir()) or (entry.name in FILES and entry.isfile()), "Unexpected tar path/type"
            total += entry.size
            assert total < 2 * 1024**3 and len(names) <= len(FILES) + len(DIRS), "Archive exceeds budget"
            members.append(entry)
        assert names == FILES | DIRS, "Missing release entries"
        os.mkdir(output, 0o700)
        for name in DIRS:
            os.mkdir(os.path.join(output, name), 0o700)
        for entry in members:
            if entry.isdir():
                continue
            count = 0
            with tar.extractfile(entry) as src, open(os.path.join(output, entry.name), "xb") as dest:
                while True:
                    data = src.read(1024 * 1024)
                    if not data:
                        break
                    count += len(data)
                    assert count <= entry.size
                    dest.write(data)
            assert count == entry.size


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--archive", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    unpack(a.archive, a.output)
