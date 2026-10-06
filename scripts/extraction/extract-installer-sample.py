"""Bounded, non-installing sample extraction from a verified macOS installer OTA.

Uses Apple's aa to list every payload, then extracts regular files in one explicit
bundle, SystemVersion.plist and required duplicate-content sources. Explicit
links.txt mappings are materialized as byte copies, never filesystem links.
This is a sample, not a complete OS image or collection package.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import threading
import zipfile

SYSTEM_VERSION = "System/Library/CoreServices/SystemVersion.plist"
MAX_BYTES = 256 * 1024 ** 2
MAX_METADATA = 64 * 1024 ** 2


def safe_path(path):
    if (not isinstance(path, str) or not path or "\\" in path
            or any(ord(c) < 32 or ord(c) == 127 for c in path)
            or any(p in ("", ".", "..") for p in path.split("/"))):
        raise ValueError("Unsafe archive path: " + repr(path))
    return path


def selected(path, bundle):
    return path == SYSTEM_VERSION or path == bundle or path.startswith(bundle + "/")


def parse_links(text):
    links, source = {}, None
    for line in text.split("\n"):
        if not line:
            continue
        path = safe_path(line[1:])
        if line[0] == "=":
            source = path
        elif line[0] == "+" and source is not None:
            if path in links or path == source:
                raise ValueError("Duplicate or self-referencing link")
            links[path] = source
        else:
            raise ValueError("Unsupported link definition")
    return links


def link_source(path, links):
    seen, chain = set(), []
    while path in links:
        if path in seen:
            raise ValueError("Cyclic link definition")
        seen.add(path)
        chain.append(dict(destination=path, source=links[path]))
        path = links[path]
    return path, chain


def validate_entries(entries, bundle, dependencies=()):
    if not isinstance(entries, list):
        raise ValueError("Expected aa JSON array")
    files, seen, total = [], set(), 0
    for entry in entries:
        path = safe_path(entry["PAT"])
        if not selected(path, bundle) and path not in dependencies:
            raise ValueError("Entry outside selected scope: " + path)
        if path in seen:
            raise ValueError("Duplicate path in payload: " + path)
        seen.add(path)
        if entry["TYP"] == "F":
            size = entry.get("DAT")
            if type(size) is not int or size < 0 or size > MAX_BYTES:
                raise ValueError("Unsupported/missing file data: " + path)
            total += size
            files.append(entry)
        elif entry["TYP"] not in ("D", "L", "H"):
            raise ValueError("Unsupported entry type: " + entry["TYP"])
    if total > MAX_BYTES:
        raise ValueError("Sample byte budget exceeded")
    return files


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    with path.open("x") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")


def run_aa(z, member, args, stdout, stderr):
    # No shell, no installer scripts; process timeout also covers stdin feeding.
    with stdout.open("xb") as out, stderr.open("xb") as err:
        p = subprocess.Popen(["/usr/bin/aa", *args], stdin=subprocess.PIPE,
                             stdout=out, stderr=err)
        timer = threading.Timer(300, p.kill)
        timer.start()
        try:
            with z.open(member) as src:
                shutil.copyfileobj(src, p.stdin, 1024 * 1024)
            p.stdin.close()
            code = p.wait(timeout=300)
            if code != 0:
                raise RuntimeError("aa failed for " + member + ": " + str(code))
        finally:
            timer.cancel()
            if p.poll() is None:
                p.kill()
            p.wait()


def actual_files(root):
    found = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError("Unexpected extracted symlink: " + str(path))
            if name in files:
                if not path.is_file():
                    raise ValueError("Unexpected nonregular output")
                found[path.relative_to(root).as_posix()] = path
    return found


def extract(archive, output, version, build, bundle):
    safe_path(bundle)
    # Literal ASCII bundle paths only for this prototype. Escape regex syntax.
    if not re.fullmatch(r"[A-Za-z0-9_ ./-]+\.(framework|app|bundle)", bundle):
        raise ValueError("Unsupported sample bundle path")
    output.mkdir(mode=0o700)
    parts, tree = output / "parts", output / "selected-tree"
    parts.mkdir(); tree.mkdir()
    records, origins, total = [], {}, 0
    try:
        with zipfile.ZipFile(archive) as z:
            names = [i.filename for i in z.infolist()]
            if len(names) != len(set(names)):
                raise ValueError("Duplicate ZIP member names")
            metadata = {}
            for name in ["Info.plist", "AssetData/Info.plist"]:
                if z.getinfo(name).file_size > MAX_METADATA:
                    raise ValueError("Metadata too large")
                data = z.read(name)
                metadata[name] = plistlib.loads(data)
            properties = metadata["Info.plist"]["MobileAssetProperties"]
            assert properties["OSVersion"] == version and properties["Build"] == build
            info = metadata["AssetData/Info.plist"]
            assert info["ProductVersion"] == version and info["Build"] == build
            save(output / "metadata.json", metadata)
            if z.getinfo("AssetData/post.bom").file_size > MAX_METADATA:
                raise ValueError("BOM too large")
            with (output / "post.bom").open("xb") as f:
                f.write(z.read("AssetData/post.bom"))
            # File-only BOM gives an independent expected path/size inventory.
            bom = subprocess.run(["/usr/bin/lsbom", "-f", "-p", "fs", str(output / "post.bom")],
                                 check=True, capture_output=True, timeout=120).stdout.decode()
            expected = {}
            for line in bom.splitlines():
                path, size = line.rsplit("\t", 1)
                if path.startswith("./"):
                    path = path[2:]
                if selected(path, bundle):
                    safe_path(path)
                    if path in expected:
                        raise ValueError("Duplicate BOM path")
                    expected[path] = int(size)
            save(output / "expected-files.json", expected)
            if z.getinfo("AssetData/payloadv2/links.txt").file_size > MAX_METADATA:
                raise ValueError("Links table too large")
            links_bytes = z.read("AssetData/payloadv2/links.txt")
            with (output / "links.txt").open("xb") as f:
                f.write(links_bytes)
            links = parse_links(links_bytes.decode("utf8"))
            dependencies = {link_source(p, links)[0] for p in expected if p in links}
            pattern = "^(" + "|".join([re.escape(bundle) + "(/.*)?", re.escape(SYSTEM_VERSION)]
                                        + [re.escape(p) for p in sorted(dependencies)]) + ")$"
            save(output / "dependencies.json", sorted(dependencies))
            payloads = sorted(n for n in names if re.fullmatch(r"AssetData/payloadv2/payload\.\d+", n))
            assert payloads, "No payload members"
            for index, member in enumerate(payloads):
                part = parts / member.rsplit("/", 1)[1]
                part.mkdir()
                run_aa(z, member, ["list", "-list-format", "json", "-include-regex", pattern],
                       part / "entries.json", part / "list-stderr.txt")
                if (part / "entries.json").stat().st_size > MAX_METADATA:
                    raise ValueError("Listing too large")
                entries = json.loads((part / "entries.json").read_text())
                files = validate_entries(entries, bundle, dependencies)
                record = dict(member=member, selectedEntries=len(entries), regularFiles=len(files))
                records.append(record)
                if files:
                    total += sum(e["DAT"] for e in files)
                    if total > MAX_BYTES:
                        raise ValueError("Total sample byte budget exceeded")
                    root = part / "files"
                    root.mkdir()
                    # Do not create links, device nodes or original privileged attrs.
                    run_aa(z, member, ["extract", "-d", str(root), "-include-regex", pattern,
                                      "-include-type", "f", "-exclude-field", "attr,xat,acl", "-afsc-none"],
                           part / "extract-stdout.txt", part / "extract-stderr.txt")
                    actual = actual_files(root)
                    if set(actual) != {e["PAT"] for e in files}:
                        raise ValueError("Extracted path set does not match aa listing")
                    for entry in files:
                        path = entry["PAT"]
                        source = actual[path]
                        assert source.stat().st_size == entry["DAT"]
                        h = sha(source)
                        if path in origins and origins[path]["sha256"] != h:
                            raise ValueError("Conflicting payload variants: " + path)
                        if path not in origins:
                            target = tree / path
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with source.open("rb") as src, target.open("xb") as dst:
                                shutil.copyfileobj(src, dst, 1024 * 1024)
                            assert sha(target) == h
                            origins[path] = dict(bytes=entry["DAT"], sha256=h, members=[])
                        origins[path]["members"].append(member)
                print(json.dumps(dict(payload=index + 1, total=len(payloads), **record)), flush=True)
            for destination in sorted(expected):
                if destination not in links:
                    continue
                source, chain = link_source(destination, links)
                if source not in origins:
                    raise ValueError("Missing explicit link source: " + source)
                original = origins[source]
                if destination in origins:
                    if origins[destination]["sha256"] != original["sha256"]:
                        raise ValueError("Link conflicts with payload data")
                    continue
                total += original["bytes"]
                if total > MAX_BYTES:
                    raise ValueError("Expanded sample byte budget exceeded")
                target = tree / destination
                target.parent.mkdir(parents=True, exist_ok=True)
                with (tree / source).open("rb") as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                assert sha(target) == original["sha256"]
                origins[destination] = dict(bytes=original["bytes"], sha256=original["sha256"],
                    members=original["members"], representation="copy-of-explicit-installer-link",
                    linkChain=chain)
            save(output / "origins.json", origins)
            dependency_only = dependencies - set(expected)
            actual_sizes = {p: r["bytes"] for p, r in origins.items() if p not in dependency_only}
            comparison = dict(missing=sorted(set(expected) - set(actual_sizes)),
                              extra=sorted(set(actual_sizes) - set(expected)),
                              sizeMismatches=[p for p in expected if p in actual_sizes and expected[p] != actual_sizes[p]])
            save(output / "bom-comparison.json", comparison)
            if not expected or any(comparison.values()):
                raise ValueError("Sample differs from post.bom; preserve for investigation")
            system = plistlib.loads((tree / SYSTEM_VERSION).read_bytes())
            assert system["ProductVersion"] == version and system["ProductBuildVersion"] == build
            save(output / "result.json", dict(status="sample-regular-files-extracted-bom-matched",
                 version=version, build=build, systemVersion=system, bundle=bundle,
                 payloads=records, files=len(actual_sizes), bytes=sum(actual_sizes.values()),
                 dependencyOnly=sorted(dependency_only), linksRestored=sum("linkChain" in r for r in origins.values()),
                 scope="selected-bundle-and-system-version; not-whole-os",
                 omitted="filesystem links, nonregular entries, cryptexes, other bundles except explicit dependencies; see per-payload entries.json"))
    except Exception as error:
        save(output / "failed.json", dict(status="failed-preserved", error=str(error)))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["archive", "output", "version", "build", "bundle"]:
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    extract(Path(args.archive), Path(args.output), args.version, args.build, args.bundle)
