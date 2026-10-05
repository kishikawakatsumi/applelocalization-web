"""Extract fixed intermediate layouts; v2 additionally allows manifest-pinned quarantine."""
import argparse
import os
import tarfile
import json
import re

FILES = {"release.json", "package/report.json", "package/catalog.json"}
FILES.update("package/" + n + ".jsonl.gz" for n in ("sources", "resources", "tables", "occurrences", "issues", "symlinks"))
FILES.update("evidence/" + n for n in ("package.complete.json", "package-audit.complete.json", "audit.json", "transfer-manifest.json"))
DIRS = {"package", "evidence"}
QUARANTINE = re.compile(r"package/quarantine/[a-f0-9]{64}\.(strings|stringsdict|loctable)\Z")


def unpack(archive, output):
    with tarfile.open(archive, "r:") as tar:
        members = []
        names = set()
        total = 0
        for entry in tar:
            assert entry.name not in names, "Duplicate tar member"
            names.add(entry.name)
            assert ((entry.name in DIRS or entry.name == "package/quarantine") and entry.isdir()) or ((entry.name in FILES or QUARANTINE.fullmatch(entry.name)) and entry.isfile()), "Unexpected tar path/type"
            total += entry.size
            assert total < 2 * 1024**3 and len(names) <= 20032, "Archive exceeds budget"
            members.append(entry)
        manifests = [m for m in members if m.name == "release.json"]
        assert len(manifests) == 1 and manifests[0].size <= 8 * 1024**2, "Missing/oversized manifest"
        manifest = json.load(tar.extractfile(manifests[0]))
        version = manifest.get("formatVersion")
        assert version in (1, 2), "Unknown release format"
        allowed_files, allowed_dirs = set(FILES), set(DIRS)
        if version == 2:
            for name, value in manifest["files"].items():
                if QUARANTINE.fullmatch(name):
                    assert value is not None
                    allowed_files.add(name)
                    allowed_dirs.add("package/quarantine")
                elif name == "package/quarantine/":
                    assert value is None
                    allowed_dirs.add("package/quarantine")
        assert names == allowed_files | allowed_dirs, "Missing or unexpected release entries"
        os.mkdir(output, 0o700)
        for name in sorted(allowed_dirs):
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
