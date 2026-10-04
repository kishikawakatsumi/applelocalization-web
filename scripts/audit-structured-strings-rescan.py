"""Compare a v2 rescan with saved v1 scan and independently decode recovered originals.

Existing successful rows must remain exactly equal. Newly accepted dictionary
targets are checked against hash-pinned quarantine bytes using plistlib (OpenStep
fallback is counted separately). This is not a full original audit of old rows.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path

helper_path = Path(__file__).with_name("audit-installer-scan.py")
spec = importlib.util.spec_from_file_location("value_audit", helper_path)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit(before, after):
    before, after = Path(before), Path(after)
    old_report = json.loads((before / "report.json").read_bytes())
    new_report = json.loads((after / "report.json").read_bytes())
    require(old_report["source"]["sourceId"] == new_report["source"]["sourceId"], "Wrong source")
    require(old_report["source"]["scope"] == new_report["source"]["scope"], "Changed scope")
    require(old_report["bundlePolicy"] == new_report["bundlePolicy"], "Changed bundle policy")
    require(new_report["resourceParserPolicy"]["version"] == 2, "Parser v2 required")
    old_files, new_files = list(h.lines(before / "files.jsonl.gz")), list(h.lines(after / "files.jsonl.gz"))
    require([f["resourceId"] for f in old_files] == [f["resourceId"] for f in new_files], "Resource order/coverage changed")
    require(len({f["resourceId"] for f in old_files}) == len(old_files), "Duplicate resource")
    old_rows, new_rows = iter(h.lines(before / "rows.jsonl.gz")), iter(h.lines(after / "rows.jsonl.gz"))
    counts, decoders = Counter(), Counter()
    recovered = []
    for old, new in zip(old_files, new_files):
        for key in ("resourceId", "sourceId", "imagePath", "bundlePath", "resourcePath", "bundleName", "bundleAssignment", "sha256", "bytes"):
            require(old.get(key) == new.get(key), "Resource context changed: " + key)
        evidence = json.loads(json.dumps(old.get("bundleEvidence")))
        if evidence:
            for problem in evidence.get("problems", []):
                problem["message"] = problem["message"].replace(old_report["source"]["root"], new_report["source"]["root"])
        require(evidence == new.get("bundleEvidence"), "Bundle evidence changed")
        if old["status"] == "parsed":
            require(new["status"] == "parsed" and new["rows"] == old["rows"], "Previously parsed resource changed")
            for _ in range(old["rows"]):
                a, b = next(old_rows, None), next(new_rows, None)
                require(a is not None and b is not None and h.same_json(a, b), "Existing row changed")
                require(a["resourceId"] == old["resourceId"], "Wrong existing row reference")
                counts["unchangedRows"] += 1
            counts["unchangedParsedFiles"] += 1
        elif new["status"] == "failed":
            require(old["status"] == "failed" and old["error"] == new["error"], "Unresolved reason changed")
            require(old["quarantinePath"] == new["quarantinePath"], "Quarantine path changed")
            for directory in (before, after):
                raw = h.image_file(directory, "/" + old["quarantinePath"]).read_bytes()
                require(h.sha(raw) == old["sha256"], "Unresolved original changed")
            counts["remainingFailedFiles"] += 1
        else:
            require(old["status"] == "failed" and new["status"] == "parsed", "Unexpected status transition")
            require(old["error"].startswith("Non-string value in .strings:"), "Unrelated recovery")
            raw = h.image_file(before, "/" + old["quarantinePath"]).read_bytes()
            require(h.sha(raw) == old["sha256"] and len(raw) == old["bytes"], "Quarantine hash mismatch")
            value = h.decode(raw, decoders)
            require(isinstance(value, dict) and any(isinstance(v, dict) for v in value.values()), "No dictionary-valued target")
            require(all(isinstance(v, (str, dict)) for v in value.values()), "Unsupported top-level target")
            locales = [p[:-6] for p in old["resourcePath"].split("/")[:-1] if p.endswith(".lproj")]
            require(len(locales) == 1 and bool(locales[0]), "Ambiguous language")
            require(new["rows"] == len(value), "Recovered count mismatch")
            seen = set()
            for _ in range(new["rows"]):
                row = next(new_rows, None)
                require(row is not None and row["resourceId"] == old["resourceId"] and row["language"] == locales[0], "Wrong recovered row")
                key = row["key"]
                require(key in value and key not in seen, "Missing/duplicate recovered key")
                require(h.same_json(row["target"], value[key]), "Recovered value mismatch")
                require(row["targetKind"] == ("text" if isinstance(value[key], str) else "structured"), "Wrong recovered type")
                seen.add(key)
                counts["recoveredRows"] += 1
                counts["recovered" + row["targetKind"].title() + "Rows"] += 1
            require(seen == set(value), "Missing recovered values")
            counts["recoveredFiles"] += 1
            recovered.append(dict(resourceId=old["resourceId"], imagePath=old["imagePath"], sha256=old["sha256"], rows=new["rows"]))
    require(next(old_rows, None) is None and next(new_rows, None) is None, "Unexpected trailing rows")
    require(counts["unchangedRows"] == old_report["counts"]["rows"], "Old count mismatch")
    require(counts["unchangedRows"] + counts["recoveredRows"] == new_report["counts"]["rows"], "New count mismatch")
    require(counts["recoveredFiles"] + counts["remainingFailedFiles"] == old_report["counts"]["failedFiles"], "Failure accounting mismatch")
    require(counts["remainingFailedFiles"] == new_report["counts"]["failedFiles"], "Remaining failures mismatch")
    for key in ("directories", "files", "resourceFiles", "symlinks", "enumerationErrors", "crossDeviceDirectories", "bundleMetadataIssues"):
        require(old_report["counts"][key] == new_report["counts"][key], "Inventory count changed: " + key)
    require(list(h.lines(before / "symlinks.jsonl.gz")) == list(h.lines(after / "symlinks.jsonl.gz")), "Links changed")
    hashes = {which: {name: h.sha((directory / name).read_bytes()) for name in ("report.json", "files.jsonl.gz", "rows.jsonl.gz", "issues.jsonl.gz", "symlinks.jsonl.gz")} for which, directory in (("before", before), ("after", after))}
    return dict(status="rescan-values-preserved-and-recovery-verified", sourceId=old_report["source"]["sourceId"], counts=dict(counts), decoders=dict(decoders),
                inputHashes=hashes, recovered=recovered, published=False,
                limitations=["Old successful rows compared with saved baseline, not independently redecoded here.", "Remaining failures and enumeration/ownership issues remain unresolved.", "Dictionary targets retained whole; not paired or approved as translations."],
                codeHashes={p.name: h.sha(p.read_bytes()) for p in (Path(__file__), helper_path)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("before", "after", "output"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    for directory in (Path(args.before).resolve(), Path(args.after).resolve()):
        require(output != directory and directory not in output.parents, "Output inside input")
    result = audit(args.before, args.after)
    with output.open("x") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"status": result["status"], "counts": result["counts"], "decoders": result["decoders"]}))
