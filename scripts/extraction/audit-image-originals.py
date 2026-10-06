"""Verify all successful whole-image scan rows against read-only mounted originals.

Binary/XML decoding uses plistlib, separately from the JS extractor. OpenStep
falls back to Apple's plutil and is explicitly counted, not independent decoding.
Failed files are rejected by default. Explicit recorded-gaps mode verifies only
language quarantines and reproduced EACCES paths, with a distinct partial status.
"""
import argparse
import errno
from collections import Counter
import json
import importlib.util
import os
from pathlib import Path
import stat
import subprocess

helper_path = Path(__file__).with_name("audit-installer-scan.py")
spec = importlib.util.spec_from_file_location("installer_value_audit", helper_path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inventory(root, recorded_denials=()):
    device = root.stat().st_dev
    resources, links, denials = set(), set(), set()
    def walk(directory):
        try:
            entries = os.scandir(directory)
        except OSError as error:
            name = "/" + directory.relative_to(root).as_posix()
            require(error.errno == errno.EACCES and name in recorded_denials, "Unexpected enumeration error: " + name)
            denials.add(name)
            return
        with entries:
            for entry in entries:
                path = Path(entry.path)
                name = "/" + path.relative_to(root).as_posix()
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError as error:
                    require(error.errno == errno.EACCES and name in recorded_denials, "Unexpected stat error: " + name)
                    denials.add(name)
                    continue
                if stat.S_ISLNK(info.st_mode):
                    links.add(name)
                elif stat.S_ISDIR(info.st_mode):
                    require(info.st_dev == device, "Cross-device directory: " + name)
                    walk(path)
                elif stat.S_ISREG(info.st_mode) and path.suffix in (".strings", ".stringsdict", ".loctable"):
                    resources.add(name)
    walk(root)
    require(denials == set(recorded_denials), "Recorded enumeration gaps changed")
    return resources, links


def audit(root, scan, require_readonly=True, allow_recorded_gaps=False):
    root, scan = Path(root).resolve(), Path(scan).resolve()
    require(root != Path("/"), "Host root refused")
    if require_readonly:
        mounts = subprocess.check_output(["/sbin/mount"], text=True).splitlines()
        matches = [line for line in mounts if " on " + str(root) + " (" in line]
        require(len(matches) == 1 and "read-only" in matches[0].rsplit(" (", 1)[1].rstrip(")").split(", "), "Read-only mount required")
    report = json.loads((scan / "report.json").read_bytes())
    require(report["source"]["scope"]["kind"] == "whole-image", "Whole-image scan required")
    require(Path(report["source"]["root"]).resolve() == root, "Wrong original root")
    require(report["status"] in ("complete-within-scope", "scanned-with-issues"), "Incomplete scan")
    for key in (("crossDeviceDirectories",) if allow_recorded_gaps else ("failedFiles", "enumerationErrors", "crossDeviceDirectories", "quarantinedFiles")):
        require(report["counts"][key] == 0, "Unsupported partial scan: " + key)
    issues = list(helper.lines(scan / "issues.jsonl.gz"))
    denials = [i["imagePath"] for i in issues if i["stage"] == "enumeration" and i.get("code") == "EACCES"] if allow_recorded_gaps else []
    require(len(set(denials)) == len(denials) == report["counts"]["enumerationErrors"], "Enumeration gaps must be explicit EACCES paths")
    expected, symlinks = inventory(root, denials)
    rows = iter(helper.lines(scan / "rows.jsonl.gz"))
    seen, ids, metadata = set(), set(), {}
    counts, decoders, metadata_decoders, languages = (Counter() for _ in range(4))
    for file in helper.lines(scan / "files.jsonl.gz"):
        path = file["imagePath"]
        require(path in expected and path not in seen, "Unexpected/duplicate resource: " + path)
        seen.add(path)
        require(file["resourceId"] not in ids, "Duplicate resource ID")
        ids.add(file["resourceId"])
        identity = json.dumps([report["source"]["sourceId"], path], ensure_ascii=False, separators=(",", ":"))
        require(helper.sha(identity.encode()) == file["resourceId"], "Resource ID mismatch")
        require(file["sourceId"] == report["source"]["sourceId"], "Source ID mismatch")
        data = helper.image_file(root, path).read_bytes()
        require(helper.sha(data) == file["sha256"] and len(data) == file["bytes"], "Original hash/size mismatch: " + path)
        if file["status"] == "failed" and allow_recorded_gaps:
            require(file["error"] == "Expected exactly one nonempty .lproj directory; refusing to guess language", "Unsupported failed resource")
            require(file.get("rows", 0) == 0, "Failed resource has rows")
            require(helper.image_file(scan, "/" + file["quarantinePath"]).read_bytes() == data, "Quarantine original mismatch")
            locales = [p[:-6] for p in path.split("/")[:-1] if p.endswith(".lproj")]
            require(len(locales) != 1 or not locales[0], "Language failure not reproduced")
            counts["failedFiles"] += 1
            continue
        require(file["status"] == "parsed", "Unparsed file")
        for meta in (file.get("bundleEvidence") or {}).get("metadata", []):
            name = meta["imagePath"]
            if name not in metadata:
                raw = helper.image_file(root, name).read_bytes()
                value = helper.decode(raw, metadata_decoders)
                metadata[name] = (helper.sha(raw), len(raw), value.get("CFBundleIdentifier"))
            require(metadata[name] == (meta["sha256"], meta["bytes"], meta["identifier"]), "Metadata mismatch: " + name)
        value = helper.decode(data, decoders)
        require(isinstance(value, dict), "Nondictionary resource")
        if file["format"] == "loctable":
            tables = {lang: table for lang, table in value.items() if lang != "LocProvenance"}
        else:
            require(file["format"] in ("strings", "stringsdict"), "Unsupported format")
            locales = [part[:-6] for part in path.split("/")[:-1] if part.endswith(".lproj")]
            require(len(locales) == 1 and bool(locales[0]), "Ambiguous language")
            tables = {locales[0]: value}
        wanted = {(lang, key): target for lang, table in tables.items() for key, target in table.items()}
        require(len(wanted) == file["rows"], "Original row count differs")
        observed = set()
        for _ in range(file["rows"]):
            row = next(rows, None)
            require(row is not None, "Missing row")
            key = (row["language"], row["key"])
            require(row["resourceId"] == file["resourceId"] and key in wanted and key not in observed, "Wrong/duplicate row")
            target = wanted[key]
            require(helper.same_json(row["target"], target), "Original value mismatch: " + path)
            require(row["targetKind"] == ("text" if isinstance(target, str) else "structured"), "Wrong value type")
            observed.add(key)
            counts["rows"] += 1
            counts[row["targetKind"] + "Rows"] += 1
            languages[row["language"]] += 1
        require(observed == set(wanted), "Missing values")
        counts["parsedFiles"] += 1
    require(seen == expected and next(rows, None) is None, "Missing files or extra rows")
    saved_links = list(helper.lines(scan / "symlinks.jsonl.gz"))
    require(len(saved_links) == len(symlinks) and {x["imagePath"] for x in saved_links} == symlinks, "Symlink inventory mismatch")
    for key in ("rows", "textRows", "structuredRows", "parsedFiles"):
        require(counts[key] == report["counts"][key], "Count mismatch: " + key)
    require(len(seen) == report["counts"]["resourceFiles"], "Resource count mismatch")
    require(sorted(languages) == report["languageCodes"], "Language inventory mismatch")
    require(counts["failedFiles"] == report["counts"]["failedFiles"] == report["counts"]["quarantinedFiles"], "Failed resource accounting mismatch")
    partial = bool(denials or counts["failedFiles"])
    return dict(status="recorded-scope-rows-match-originals-with-gaps" if partial else "all-image-rows-match-originals", sourceId=report["source"]["sourceId"],
                recordedGaps=dict(enumerationPaths=sorted(denials), quarantinedLanguageFiles=counts["failedFiles"]),
                resourceFiles=len(seen), counts=dict(counts), decoders=dict(decoders),
                verifiedMetadataFiles=len(metadata), metadataDecoders=dict(metadata_decoders),
                symlinksNotFollowed=len(symlinks), languageRows=dict(sorted(languages.items())),
                inputHashes={name: helper.sha((scan / name).read_bytes()) for name in
                             ("report.json", "files.jsonl.gz", "rows.jsonl.gz", "symlinks.jsonl.gz", "issues.jsonl.gz")},
                codeHashes={path.name: helper.sha(path.read_bytes()) for path in (Path(__file__), helper_path)},
                limitations=["OpenStep fallback shares Apple's plutil; counted separately.",
                             "Recorded gaps, if present, remain unresolved; no claim about inaccessible descendants or quarantined languages.",
                             "Supported resource inventory only; no symlink traversal or compiled UI decoding.",
                             "Metadata values checked; ownership boundaries require separate verification.",
                             "No linguistic approval, DB import or publication."], published=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "scan", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--allow-recorded-gaps", action="store_true", help="Verify recorded language quarantines and exact EACCES gaps; never approve whole-image completeness")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    for source in (Path(args.root).resolve(), Path(args.scan).resolve()):
        require(source != output and source not in output.parents, "Output inside input")
    result = audit(args.root, args.scan, allow_recorded_gaps=args.allow_recorded_gaps)
    with output.open("x") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"status": result["status"], "counts": result["counts"], "decoders": result["decoders"]}))
