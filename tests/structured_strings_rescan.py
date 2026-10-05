import gzip
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("rescan", Path(__file__).resolve().parents[1] / "scripts/audit-structured-strings-rescan.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RescanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="structured-rescan-")
        self.addCleanup(self.temp.cleanup)
        self.before, self.after = [Path(self.temp.name) / d for d in ("before", "after")]
        for directory in (self.before, self.after):
            (directory / "quarantine").mkdir(parents=True)
        value = {"FSPersonalities": {"AFPFS": {"FSName": "共有"}}, "name": "\u0000"}
        raw = plistlib.dumps(value, fmt=plistlib.FMT_BINARY)
        (self.before / "quarantine/new.strings").write_bytes(raw)
        old = dict(resourceId="old", sourceId="fixture", imagePath="/ja.lproj/A.strings", resourcePath="ja.lproj/A.strings", status="parsed", rows=1, sha256="same")
        new = dict(resourceId="new", sourceId="fixture", imagePath="/ja.lproj/B.strings", resourcePath="ja.lproj/B.strings", status="failed", sha256=module.h.sha(raw), bytes=len(raw), quarantinePath="quarantine/new.strings", error="Non-string value in .strings: FSPersonalities")
        self.old_files = [old, new]
        self.new_files = [old.copy(), {**new, "status": "parsed", "rows": 2}]
        self.old_rows = [dict(resourceId="old", language="ja", key="Open", target="開く", targetKind="text")]
        self.new_rows = self.old_rows + [dict(resourceId="new", language="ja", key=k, target=v, targetKind="text" if isinstance(v, str) else "structured") for k, v in value.items()]
        self.save()

    def save(self):
        for directory, files, rows, failed in ((self.before, self.old_files, self.old_rows, 1), (self.after, self.new_files, self.new_rows, 0)):
            report = dict(source=dict(sourceId="fixture", scope=dict(kind="whole-image"), root="/fixture"), bundlePolicy=dict(version=4), resourceParserPolicy=dict(version=2), counts=dict(rows=len(rows), failedFiles=failed, directories=1, files=2, resourceFiles=2, symlinks=0, enumerationErrors=0, crossDeviceDirectories=0, bundleMetadataIssues=0))
            (directory / "report.json").write_text(json.dumps(report))
            for name, data in (("files", files), ("rows", rows), ("issues", []), ("symlinks", [])):
                with gzip.open(directory / (name + ".jsonl.gz"), "wt") as stream:
                    for obj in data:
                        stream.write(json.dumps(obj) + "\n")

    def test_recovery_and_preservation(self):
        r = module.audit(self.before, self.after)
        self.assertEqual(r["counts"]["recoveredFiles"], 1)
        self.assertEqual(r["counts"]["recoveredRows"], 2)
        self.assertEqual(r["counts"]["unchangedRows"], 1)

    def test_existing_value_change_rejected(self):
        self.new_rows[0] = {**self.new_rows[0], "target": "別訳"}
        self.save()
        with self.assertRaisesRegex(ValueError, "Existing row changed"):
            module.audit(self.before, self.after)

    def test_recovered_value_change_rejected(self):
        self.new_rows[1]["target"] = {"flattened": "共有"}
        self.save()
        with self.assertRaisesRegex(ValueError, "Recovered value mismatch"):
            module.audit(self.before, self.after)

    def test_wrong_language_rejected(self):
        self.new_rows[1]["language"] = "en"
        self.save()
        with self.assertRaisesRegex(ValueError, "Wrong recovered row"):
            module.audit(self.before, self.after)

    def test_original_hash_checked(self):
        (self.before / "quarantine/new.strings").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Quarantine hash mismatch"):
            module.audit(self.before, self.after)


if __name__ == "__main__":
    unittest.main()
