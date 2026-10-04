"""Stream all parsed rows against original plist values and summarize unresolved files.

plistlib directly reads binary/XML. For legacy OpenStep, Apple's plutil converts
to XML first; this fallback is explicitly counted, not called an independent
OpenStep parser. No language alias normalization, pairing, or linguistic review.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess


def sha(data):
    return hashlib.sha256(data).hexdigest()


def same_json(a, b):
    # Python considers True == 1; JSON does not. JSON numbers have one type.
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_json(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b))
    return a == b


def lines(path):
    with gzip.open(path, "rb") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def decode(data, counts):
    try:
        value = plistlib.loads(data)
        counts["plistlibDirect"] += 1
        return value
    except plistlib.InvalidFileException:
        converted = subprocess.run(["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "--", "-"],
            input=data, capture_output=True, check=True, timeout=30).stdout
        counts["plutilXmlFallback"] += 1
        return plistlib.loads(converted)


def image_file(root, name):
    if not isinstance(name, str) or not name.startswith("/"):
        raise ValueError("Invalid image path")
    parts = name[1:].split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("Invalid image path components")
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("Symlink in original path")
    return path


def audit(run, scan):
    run, scan = Path(run), Path(scan)
    extraction = json.loads((run / "result.json").read_text())
    report = json.loads((scan / "report.json").read_text())
    scope = report["source"]["scope"]
    if scope["kind"] != "installer-resource-projection" or scope["archiveSha256"] != extraction["identity"]["archiveSha256"]:
        raise ValueError("Wrong projection provenance")
    if scope["extractionReportSha256"] != sha((run / "result.json").read_bytes()):
        raise ValueError("Extraction report changed")
    if scope["auditSha256"] != sha((scan.parent / "input-audit.json").read_bytes()):
        raise ValueError("Input audit changed")
    root = run / "selected-tree"
    origins = json.loads((run / "origins.json").read_text())
    expected = {"/" + p for p in json.loads((run / "expected.json").read_text())
                if Path(p).suffix in (".loctable", ".strings", ".stringsdict")}
    rows = iter(lines(scan / "rows.jsonl.gz"))
    seen, metadata_cache = set(), {}
    counts, languages, language_files, assignments, failures, decoders = (Counter() for _ in range(6))
    unresolved, unbundled_examples = [], []
    unbundled_roots = Counter()
    for file in lines(scan / "files.jsonl.gz"):
        path = file["imagePath"]
        if path not in expected or path in seen:
            raise ValueError("Unexpected/duplicate resource: " + path)
        seen.add(path)
        data = image_file(root, path).read_bytes()
        origin = origins[path[1:]]
        if sha(data) != origin["sha256"] or file["sha256"] != origin["sha256"] or len(data) != file["bytes"]:
            raise ValueError("Original hash mismatch: " + path)
        assignments[file["bundleAssignment"]] += 1
        if file["bundleAssignment"] == "unbundled":
            unbundled_roots["/".join(path.split("/")[:4])] += 1
            if len(unbundled_examples) < 10:
                unbundled_examples.append(path)
        for meta in (file.get("bundleEvidence") or {}).get("metadata", []):
            name = meta["imagePath"]
            if name not in metadata_cache:
                raw = image_file(root, name).read_bytes()
                obj = decode(raw, Counter())
                metadata_cache[name] = (sha(raw), obj.get("CFBundleIdentifier"))
            if metadata_cache[name] != (meta["sha256"], meta["identifier"]):
                raise ValueError("Bundle metadata mismatch: " + name)
            if meta["sha256"] != origins[name[1:]]["sha256"]:
                raise ValueError("Bundle metadata absent from extraction provenance")
        if file["status"] == "failed":
            reason = file["error"]
            category = "language-not-uniquely-determined" if "exactly one nonempty .lproj" in reason else "decode-or-resource-structure"
            failures[category] += 1
            unresolved.append(dict(imagePath=path, category=category, error=reason, bundlePath=file["bundlePath"]))
            counts["failedFiles"] += 1
            continue
        if file["status"] != "parsed":
            raise ValueError("Unknown file status")
        value = decode(data, decoders)
        if not isinstance(value, dict):
            raise ValueError("Parsed nondictionary")
        if file["format"] == "loctable":
            tables = {language: table for language, table in value.items() if language != "LocProvenance"}
        else:
            dirs = [p[:-6] for p in file["resourcePath"].split("/")[:-1] if p.endswith(".lproj")]
            if len(dirs) != 1 or not dirs[0]:
                raise ValueError("Parsed ambiguous locale")
            tables = {dirs[0]: value}
        wanted = {(lang, key): target for lang, table in tables.items() for key, target in table.items()}
        if len(wanted) != file["rows"]:
            raise ValueError("Original row count differs: " + path)
        observed = set()
        for _ in range(file["rows"]):
            row = next(rows)
            identity = (row["language"], row["key"])
            if row["resourceId"] != file["resourceId"] or identity not in wanted or identity in observed:
                raise ValueError("Wrong/duplicate row: " + path)
            original = wanted[identity]
            if not same_json(row["target"], original) or row["targetKind"] != ("text" if isinstance(original, str) else "structured"):
                raise ValueError("Original value mismatch: " + path)
            observed.add(identity)
            counts["rows"] += 1
            counts[row["targetKind"] + "Rows"] += 1
            languages[row["language"]] += 1
        if observed != set(wanted):
            raise ValueError("Missing original rows")
        language_files.update({lang for lang, _ in observed})
        counts["parsedFiles"] += 1
    if seen != expected or next(rows, None) is not None:
        raise ValueError("Missing files or excess rows")
    for key in ["rows", "textRows", "structuredRows", "parsedFiles", "failedFiles"]:
        if counts[key] != report["counts"][key]:
            raise ValueError("Count mismatch: " + key)
    if sorted(languages) != report["languageCodes"]:
        raise ValueError("Language inventory mismatch")
    metadata_problems = []
    for issue in lines(scan / "issues.jsonl.gz"):
        if issue["stage"] != "bundle-metadata":
            continue
        name = issue["imagePath"]
        data = image_file(root, name).read_bytes()
        if sha(data) != origins[name[1:]]["sha256"]:
            raise ValueError("Problematic metadata differs from original")
        detail = dict(imagePath=name, sha256=sha(data), scannerError=issue["message"])
        try:
            obj = decode(data, Counter())
            detail["identifierFieldPresent"] = isinstance(obj, dict) and "CFBundleIdentifier" in obj
            detail["identifierType"] = type(obj.get("CFBundleIdentifier")).__name__ if isinstance(obj, dict) else None
        except Exception as error:
            detail["originalDecodeError"] = str(error)
        metadata_problems.append(detail)
    return dict(status="all-parsed-rows-match-originals", resourceFiles=len(seen), counts=dict(counts),
        decoders=dict(decoders), languageRows=dict(sorted(languages.items())), languageFiles=dict(sorted(language_files.items())),
        bundleAssignments=dict(assignments), verifiedBundleMetadataFiles=len(metadata_cache),
        failureCategories=dict(failures), unresolved=unresolved,
        rawLanguageLabels=len(languages), metadataProblems=metadata_problems,
        unbundledByRoot=dict(unbundled_roots), unbundledExamples=unbundled_examples,
        limitations=["Failed resources remain unresolved and preserved, not verified parsed rows.",
            "Language spellings are retained; directory names and locale codes are not normalized or paired.",
            "Bundle identifiers verified against metadata; not runtime Bundle or code-signature validation.",
            "Legacy OpenStep decoding shares Apple's plutil; other original decoding uses plistlib.",
            "No linguistic review, cryptex or BaseSystem coverage, or publication."], published=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["run", "scan", "output"]:
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    result = audit(args.run, args.scan)
    with open(args.output, "x") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(json.dumps({"status": result["status"], "counts": result["counts"]}))
