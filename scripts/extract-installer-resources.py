"""Resumable regular-file projection of a verified macOS installer OTA.

Never installs an OS or creates filesystem links. Payload checkpoints are reused
only after input/code identity and every output hash have been rechecked. Failed
attempts are retained. This is not a complete OS filesystem or a publication.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("installer_sample", Path(__file__).with_name("extract-installer-sample.py"))
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)
safe_path, sha, save = sample.safe_path, sample.sha, sample.save
POLICY = "resources-and-localized-folders-v1"
MAX_FILE = 256 * 1024 ** 2
MAX_TOTAL = 16 * 1024 ** 3
RESERVE = 10 * 1024 ** 3
PATTERN = r"(^|/)[^/]+\.lproj/|\.(strings|stringsdict|loctable|xcstrings)$|(^|/)(Info|version|SystemVersion)\.plist$"


def selected(path):
    return re.search(PATTERN, path) is not None


def checked_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > sample.MAX_METADATA:
        raise ValueError("Unsafe or oversized checkpoint: " + str(path))
    return json.loads(path.read_text())


def verify_files(root, records):
    actual = sample.actual_files(root)
    if set(actual) != set(records):
        raise ValueError("Checkpoint path set changed")
    for name, record in records.items():
        safe_path(name)
        if actual[name].stat().st_size != record["bytes"] or sha(actual[name]) != record["sha256"]:
            raise ValueError("Checkpoint file changed: " + name)


def inventory(text):
    result = {}
    for line in text.splitlines():
        path, size = line.rsplit("\t", 1)
        path = safe_path(path[2:] if path.startswith("./") else path)
        if path in result or not size.isdecimal():
            raise ValueError("Invalid or duplicate BOM entry: " + path)
        result[path] = int(size)
    return result


def validate_entries(entries, wanted):
    if not isinstance(entries, list):
        raise ValueError("Expected aa array")
    files, seen = {}, set()
    for entry in entries:
        path = safe_path(entry["PAT"])
        if path in seen:
            raise ValueError("Duplicate payload path: " + path)
        seen.add(path)
        if entry["TYP"] == "F":
            size = entry.get("DAT")
            if path not in wanted:
                raise ValueError("Unexpected regular file outside BOM selection: " + path)
            if type(size) is not int or size < 0 or size > MAX_FILE or size != wanted[path]:
                raise ValueError("Payload size differs from BOM or exceeds limit: " + path)
            files[path] = size
        elif entry["TYP"] not in ("L", "H", "D"):
            raise ValueError("Unsupported entry type: " + entry["TYP"])
    if sum(files.values()) > MAX_TOTAL:
        raise ValueError("Payload byte budget exceeded")
    return files


def space(output, needed=0):
    if shutil.disk_usage(output).free < RESERVE + needed:
        raise ValueError("Insufficient free space (10 GiB reserve)")
    # Includes retained failures and duplicate staging copies, not just final tree.
    used = sum(p.stat().st_size for p in sample.actual_files(output).values())
    if used + needed > 3 * MAX_TOTAL:
        raise ValueError("Retained output budget (48 GiB) exceeded")


def attempt(parent):
    parent.mkdir(exist_ok=True)
    if parent.is_symlink():
        raise ValueError("Symlink checkpoint directory")
    return Path(tempfile.mkdtemp(prefix="attempt-", dir=parent))


def copy_file(source, target, record):
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, target.open("xb") as dst:
        shutil.copyfileobj(src, dst, 1024 * 1024)
    if target.stat().st_size != record["bytes"] or sha(target) != record["sha256"]:
        raise ValueError("Copy mismatch: " + str(target))


def extract(archive, output, version, build, resume=False, stop_after=None, ota_version=None):
    archive, output = Path(archive).resolve(), Path(output).absolute()
    if output.is_symlink():
        raise ValueError("Symlink output")
    if output.exists() and not resume:
        raise FileExistsError("Use --resume for existing output")
    output.mkdir(mode=0o700, exist_ok=resume)
    # A kernel-managed lock is released even if the process is killed.
    lockpath = output / ".lock"
    if lockpath.is_symlink():
        raise ValueError("Symlink lock")
    with lockpath.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return run(archive, output, version, build, stop_after, ota_version or version)


def run(archive, output, version, build, stop_after, ota_version):
    space(output)
    print(json.dumps({"stage": "pinning-input", "archive": str(archive)}), flush=True)
    identity = dict(formatVersion=1, policy=POLICY, version=version, build=build, otaVersion=ota_version,
                    archiveSha256=sha(archive), archiveBytes=archive.stat().st_size,
                    codeSha256=sha(Path(__file__)), helperSha256=sha(Path(sample.__file__)),
                    maximumFileBytes=MAX_FILE, maximumSelectedBytes=MAX_TOTAL)
    pin = output / "input.json"
    if pin.exists():
        if checked_json(pin) != identity:
            raise ValueError("Input, policy or code changed; use a new output directory")
    else:
        save(pin, identity)
    job = attempt(output / "runs")
    try:
        with zipfile.ZipFile(archive) as z:
            names = [i.filename for i in z.infolist()]
            if len(names) != len(set(names)):
                raise ValueError("Duplicate ZIP names")
            def read(name):
                if z.getinfo(name).file_size > sample.MAX_METADATA:
                    raise ValueError("Oversized metadata")
                return z.read(name)
            properties = plistlib.loads(read("Info.plist"))["MobileAssetProperties"]
            info = plistlib.loads(read("AssetData/Info.plist"))
            if (properties["OSVersion"], properties["Build"], info["ProductVersion"], info["Build"]) != (ota_version, build, version, build):
                raise ValueError("Internal version/build mismatch")
            bompath = job / "post.bom"
            bompath.write_bytes(read("AssetData/post.bom"))
            bom = inventory(subprocess.run(["/usr/bin/lsbom", "-f", "-p", "fs", str(bompath)],
                check=True, capture_output=True, timeout=120).stdout.decode())
            links = sample.parse_links(read("AssetData/payloadv2/links.txt").decode("utf8"))
            expected = {p: s for p, s in bom.items() if selected(p)}
            if sample.SYSTEM_VERSION not in expected:
                raise ValueError("Missing SystemVersion in selection")
            dependencies = {sample.link_source(p, links)[0] for p in expected if p in links}
            if dependencies - set(bom):
                raise ValueError("Explicit dependency absent from BOM")
            wanted = {p: bom[p] for p in set(expected) | dependencies}
            if max(wanted.values()) > MAX_FILE or sum(wanted.values()) > MAX_TOTAL:
                raise ValueError("Selected BOM exceeds byte limits")
            save(job / "expected.json", expected)
            save(job / "dependencies.json", sorted(dependencies - set(expected)))
            # File paths selected by prefix are safe only after aa listing verifies
            # every selected regular file against the exact BOM path set.
            depfile = job / "dependency-paths.txt"
            depfile.write_text("\n".join(sorted(dependencies)) + "\n")
            filters = ["-include-regex", PATTERN, "-include-path-list", str(depfile)]
            members = sorted(n for n in names if re.fullmatch(r"AssetData/payloadv2/payload\.\d+", n))
            if not members:
                raise ValueError("No data payloads")
            print(json.dumps(dict(stage="planned", files=len(expected), bytes=sum(expected.values()),
                dependencies=len(dependencies - set(expected)), payloads=len(members))), flush=True)
            origins, locations, records, reused, completed = {}, {}, [], 0, 0
            parts = output / "parts"
            parts.mkdir(exist_ok=True)
            for member in members:
                parent = parts / member.rsplit("/", 1)[1]
                parent.mkdir(exist_ok=True)
                candidates = sorted(parent.glob("attempt-*/complete.json"))
                if candidates:
                    if len(candidates) != 1:
                        raise ValueError("Ambiguous completed checkpoints")
                    checkpoint = candidates[0]
                    record = checked_json(checkpoint)
                    part = checkpoint.parent
                    if record["identity"] != identity or record["member"] != member:
                        raise ValueError("Checkpoint identity mismatch")
                    verify_files(part / "files", record["files"])
                    entries = checked_json(part / "entries.json")
                    files = validate_entries(entries, wanted)
                    if files != {p: r["bytes"] for p, r in record["files"].items()}:
                        raise ValueError("Checkpoint/listing mismatch")
                    reused += 1
                else:
                    part = attempt(parent)
                    sample.run_aa(z, member, ["list", "-list-format", "json", *filters],
                        part / "entries.json", part / "list-stderr.txt")
                    entries = checked_json(part / "entries.json")
                    files = validate_entries(entries, wanted)
                    space(output, sum(files.values()))
                    root = part / "files"
                    root.mkdir()
                    if files:
                        sample.run_aa(z, member, ["extract", "-d", str(root), *filters,
                            "-include-type", "f", "-exclude-field", "attr,xat,acl", "-afsc-none"],
                            part / "extract-stdout.txt", part / "extract-stderr.txt")
                    actual = sample.actual_files(root)
                    if set(actual) != set(files):
                        raise ValueError("Extracted paths differ from aa listing")
                    file_records = {}
                    for path, size in files.items():
                        if actual[path].stat().st_size != size:
                            raise ValueError("Extracted size mismatch")
                        file_records[path] = dict(bytes=size, sha256=sha(actual[path]))
                    record = dict(identity=identity, member=member, files=file_records,
                                  omittedNonregular=[e for e in entries if e["TYP"] != "F"])
                    # Complete marker only becomes visible after a full JSON write.
                    save(part / "complete.pending.json", record)
                    os.rename(part / "complete.pending.json", part / "complete.json")
                    completed += 1
                records.append(dict(member=member, checkpoint=str(part), files=len(record["files"])))
                for path, meta in record["files"].items():
                    if path in origins and origins[path]["sha256"] != meta["sha256"]:
                        raise ValueError("Conflicting payload variants: " + path)
                    if path not in origins:
                        origins[path] = dict(**meta, members=[])
                        locations[path] = part / "files" / path
                    origins[path]["members"].append(member)
                print(json.dumps(dict(stage="payload", done=len(records), total=len(members),
                    reused=reused, member=member, files=len(record["files"]))), flush=True)
                if stop_after is not None and completed >= stop_after:
                    result = dict(status="paused-after-payload-checkpoint", completed=len(records), reused=reused)
                    save(job / "result.json", result)
                    return result
            # Detect missing/conflicting data BEFORE constructing the projection.
            for destination in sorted(expected):
                if destination not in links:
                    continue
                source, chain = sample.link_source(destination, links)
                if source not in origins:
                    raise ValueError("Missing link source: " + source)
                original = origins[source]
                if destination in origins and origins[destination]["sha256"] != original["sha256"]:
                    raise ValueError("Link/payload conflict: " + destination)
                origins[destination] = dict(bytes=original["bytes"], sha256=original["sha256"],
                    members=original["members"], linkChain=chain, representation="copy-of-explicit-installer-link")
                locations[destination] = locations[source]
            comparison = dict(missing=sorted(set(wanted) - set(origins)), extra=sorted(set(origins) - set(wanted)),
                sizeMismatches=[p for p in wanted if p in origins and wanted[p] != origins[p]["bytes"]])
            save(job / "bom-comparison.json", comparison)
            if any(comparison.values()):
                raise ValueError("Selected resources differ from BOM; see comparison")
            space(output, sum(wanted.values()))
            tree = job / "selected-tree"
            tree.mkdir()
            # Dependencies kept in checkpoints, not projected into other bundles.
            for path in sorted(expected):
                copy_file(locations[path], tree / path, origins[path])
            verify_files(tree, {p: origins[p] for p in expected})
            system = plistlib.loads((tree / sample.SYSTEM_VERSION).read_bytes())
            if (system["ProductVersion"], system["ProductBuildVersion"]) != (version, build):
                raise ValueError("Extracted SystemVersion mismatch")
            save(job / "origins.json", origins)
            result = dict(status="resource-projection-bom-matched", identity=identity,
                scope="regular payload resources, localized-folder files and metadata; not whole OS",
                omitted="cryptexes, BaseSystem, filesystem links, other assets; opaque formats retained but not decoded",
                files=len(expected), bytes=sum(expected.values()), payloads=records, reusedPayloads=reused,
                linksRestored=sum(p in links for p in expected), dependencyFiles=len(dependencies - set(expected)),
                tree=str(tree), installerExecuted=False, published=False)
            save(job / "result.json", result)
            print(json.dumps(result), flush=True)
            return result
    except Exception as error:
        save(job / "failed.json", dict(error=str(error), status="failed-preserved"))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["archive", "output", "version", "build"]:
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--ota-version")
    parser.add_argument("--stop-after-payloads", type=int)
    args = parser.parse_args()
    if args.stop_after_payloads is not None and args.stop_after_payloads < 1:
        parser.error("--stop-after-payloads must be positive")
    os.umask(0o077)
    extract(args.archive, args.output, args.version, args.build, args.resume, args.stop_after_payloads, args.ota_version)
