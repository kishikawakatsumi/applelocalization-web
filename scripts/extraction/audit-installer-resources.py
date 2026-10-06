"""Independently verify a completed installer resource projection on disk.

Verifies saved payload bytes, explicit copy provenance and BOM selection. Does
not authenticate the Apple distribution, decode translations or audit cryptexes.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe(path):
    if not isinstance(path, str) or not path or "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise ValueError("Invalid path")
    if any(p in ("", ".", "..") for p in path.split("/")):
        raise ValueError("Escaping path")
    return path


def files(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Invalid tree root")
    found = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError("Unexpected symlink")
            if name in names:
                if not path.is_file():
                    raise ValueError("Nonregular file")
                found[safe(path.relative_to(root).as_posix())] = path
    return found


def audit(run):
    run = Path(run).resolve()
    result = json.loads((run / "result.json").read_text())
    if result["status"] != "resource-projection-bom-matched":
        raise ValueError("Incomplete extraction")
    tree = run / "selected-tree"
    if Path(result["tree"]).resolve() != tree:
        raise ValueError("Report tree mismatch")
    expected = json.loads((run / "expected.json").read_text())
    origins = json.loads((run / "origins.json").read_text())
    bomtext = subprocess.run(["/usr/bin/lsbom", "-f", "-p", "fs", str(run / "post.bom")],
        capture_output=True, check=True, timeout=120).stdout.decode()
    selected = {}
    for line in bomtext.splitlines():
        path, size = line.rsplit("\t", 1)
        path = safe(path[2:] if path.startswith("./") else path)
        parts = path.split("/")
        if (any(p.endswith(".lproj") and p != ".lproj" for p in parts[:-1])
                or Path(path).suffix in (".strings", ".stringsdict", ".loctable", ".xcstrings")
                or parts[-1] in ("Info.plist", "version.plist", "SystemVersion.plist")):
            if path in selected:
                raise ValueError("Duplicate BOM path")
            selected[path] = int(size)
    if selected != expected:
        raise ValueError("Saved selection differs from independent BOM selection")
    if set(origins) != set(expected) | set(json.loads((run / "dependencies.json").read_text())):
        raise ValueError("Unexpected origin paths")
    payloads, omitted = {}, Counter()
    for record in result["payloads"]:
        part = Path(record["checkpoint"])
        if part.is_symlink() or part.parent.parent.resolve() != run.parent.parent / "parts":
            raise ValueError("Checkpoint outside extraction")
        cp = json.loads((part / "complete.json").read_text())
        if cp["identity"] != result["identity"] or cp["member"] != record["member"]:
            raise ValueError("Checkpoint identity mismatch")
        actual = files(part / "files")
        if set(actual) != set(cp["files"]):
            raise ValueError("Payload file set changed")
        for path, meta in cp["files"].items():
            if actual[path].stat().st_size != meta["bytes"] or digest(actual[path]) != meta["sha256"]:
                raise ValueError("Payload file bytes changed: " + path)
        payloads[record["member"]] = cp["files"]
        omitted.update(e["TYP"] for e in cp["omittedNonregular"])
    actual = files(tree)
    if set(actual) != set(expected):
        raise ValueError("Projection path set changed")
    extensions, directory_languages = Counter(), set()
    for path, origin in origins.items():
        safe(path)
        terminal, seen = path, {path}
        for edge in origin.get("linkChain", []):
            if edge["destination"] != terminal:
                raise ValueError("Broken provenance chain")
            terminal = safe(edge["source"])
            if terminal in seen:
                raise ValueError("Cyclic provenance")
            seen.add(terminal)
        if not origin["members"]:
            raise ValueError("Missing payload provenance")
        for member in origin["members"]:
            if payloads[member].get(terminal) != {"bytes": origin["bytes"], "sha256": origin["sha256"]}:
                raise ValueError("Provenance differs from saved payload")
        if path not in expected:
            continue
        if actual[path].stat().st_size != expected[path] or expected[path] != origin["bytes"] or digest(actual[path]) != origin["sha256"]:
            raise ValueError("Projection bytes differ from original: " + path)
        extensions[Path(path).suffix or "(none)"] += 1
        directory_languages.update(p[:-6] for p in path.split("/")[:-1] if p.endswith(".lproj"))
    if len(expected) != result["files"] or sum(expected.values()) != result["bytes"]:
        raise ValueError("Summary mismatch")
    return dict(status="saved-payloads-and-projection-independently-verified",
        files=len(expected), bytes=sum(expected.values()), payloads=len(payloads),
        linksRestored=sum("linkChain" in o for o in origins.values()),
        extensions=dict(sorted(extensions.items())), localizedDirectoryNames=sorted(directory_languages),
        omittedNonregularEntries=dict(omitted),
        scope=result["scope"], translationsDecoded=False, published=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = audit(args.run)
    with open(args.output, "x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(report, ensure_ascii=False))
