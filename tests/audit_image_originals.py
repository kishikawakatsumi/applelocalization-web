import copy
import gzip
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch
import errno

spec = importlib.util.spec_from_file_location("image_audit", Path(__file__).resolve().parents[1] / "scripts/audit-image-originals.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class ImageAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="image-original-audit-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root, self.scan = self.base / "image", self.base / "scan"
        self.scan.mkdir()
        self.name = "/A.app/ja.lproj/Localizable.stringsdict"
        self.path = self.root / self.name[1:]
        self.path.parent.mkdir(parents=True)
        self.value = {"Open": "開く\u0000\n\u2028", "empty": "", "plural": {"one": "1個", "other": "%d個"}, "bool": True}
        raw = plistlib.dumps(self.value, fmt=plistlib.FMT_BINARY)
        self.path.write_bytes(raw)
        self.id = audit.helper.sha(json.dumps(["fixture", self.name], separators=(",", ":")).encode())
        self.file = dict(imagePath=self.name, resourceId=self.id, sourceId="fixture", sha256=audit.helper.sha(raw), bytes=len(raw), status="parsed", format="stringsdict", rows=4)
        self.rows = [dict(resourceId=self.id, language="ja", key=k, target=v, targetKind="text" if isinstance(v, str) else "structured") for k, v in self.value.items()]
        self.report = dict(status="complete-within-scope", source=dict(root=str(self.root), sourceId="fixture", scope=dict(kind="whole-image")), languageCodes=["ja"], counts=dict(resourceFiles=1, parsedFiles=1, rows=4, textRows=2, structuredRows=2, failedFiles=0, enumerationErrors=0, crossDeviceDirectories=0, quarantinedFiles=0))
        self.save()

    def save(self):
        (self.scan / "report.json").write_text(json.dumps(self.report))
        for name, data in [("files", [self.file]), ("rows", self.rows), ("symlinks", []), ("issues", [])]:
            with gzip.open(self.scan / (name + ".jsonl.gz"), "wt") as stream:
                for row in data:
                    stream.write(json.dumps(row) + "\n")

    def run_audit(self):
        return audit.audit(self.root, self.scan, require_readonly=False)

    def test_values_including_structured_and_control_characters(self):
        report = self.run_audit()
        self.assertEqual(report["counts"]["rows"], 4)
        self.assertEqual(report["decoders"], {"plistlibDirect": 1})

    def test_changed_target(self):
        self.rows[0]["target"] = "異なる"
        self.save()
        with self.assertRaisesRegex(ValueError, "value mismatch"):
            self.run_audit()

    def test_boolean_is_not_number(self):
        self.rows[-1]["target"] = 1
        self.save()
        with self.assertRaisesRegex(ValueError, "value mismatch"):
            self.run_audit()

    def test_omitted_file_detected_by_original_walk(self):
        self.path.with_name("Other.strings").write_bytes(self.path.read_bytes())
        with self.assertRaisesRegex(ValueError, "Missing files"):
            self.run_audit()

    def test_duplicate_row(self):
        self.rows[1] = copy.deepcopy(self.rows[0])
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate row"):
            self.run_audit()

    def test_wrong_language(self):
        self.rows[0]["language"] = "en"
        self.save()
        with self.assertRaisesRegex(ValueError, "Wrong/duplicate row"):
            self.run_audit()

    def test_symlink_not_followed_and_inventory_checked(self):
        (self.root / "linked.strings").symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, "Symlink inventory"):
            self.run_audit()
        with gzip.open(self.scan / "symlinks.jsonl.gz", "wt") as stream:
            stream.write(json.dumps(dict(imagePath="/linked.strings", reason="not-followed")) + "\n")
        self.assertEqual(self.run_audit()["symlinksNotFollowed"], 1)

    def test_changed_bytes(self):
        self.path.write_bytes(plistlib.dumps({"Open": "新しい"}))
        with self.assertRaisesRegex(ValueError, "hash/size mismatch"):
            self.run_audit()

    def language_gap(self):
        raw = self.path.read_bytes()
        self.path.unlink()
        self.name = "/A.app/Unknown.strings"
        self.path = self.root / self.name[1:]
        self.path.write_bytes(raw)
        self.file.update(imagePath=self.name, resourceId=audit.helper.sha(json.dumps(["fixture", self.name], separators=(",", ":")).encode()),
                         status="failed", rows=0, quarantinePath="quarantine/original", error="Expected exactly one nonempty .lproj directory; refusing to guess language")
        (self.scan / "quarantine").mkdir()
        (self.scan / "quarantine/original").write_bytes(raw)
        self.rows = []
        self.report["languageCodes"] = []
        self.report["counts"].update(parsedFiles=0, rows=0, textRows=0, structuredRows=0, failedFiles=1, quarantinedFiles=1)
        self.save()

    def test_recorded_language_gap_is_opt_in_and_not_complete(self):
        self.language_gap()
        with self.assertRaisesRegex(ValueError, "Unsupported partial"):
            self.run_audit()
        result = audit.audit(self.root, self.scan, False, True)
        self.assertEqual(result["status"], "recorded-scope-rows-match-originals-with-gaps")
        self.assertEqual(result["counts"]["failedFiles"], 1)

    def test_changed_quarantine_rejected(self):
        self.language_gap()
        (self.scan / "quarantine/original").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Quarantine original"):
            audit.audit(self.root, self.scan, False, True)

    def test_unrelated_failure_rejected(self):
        self.language_gap()
        self.file["error"] = "Malformed plist"
        self.save()
        with self.assertRaisesRegex(ValueError, "Unsupported failed"):
            audit.audit(self.root, self.scan, False, True)

    def test_recorded_denial_must_be_reproduced_exactly(self):
        blocked = self.root / "blocked"
        blocked.mkdir()
        actual = audit.os.scandir
        def denied(path):
            if Path(path) == blocked:
                raise PermissionError(errno.EACCES, "denied", str(path))
            return actual(path)
        with patch.object(audit.os, "scandir", side_effect=denied):
            self.assertEqual(audit.inventory(self.root, ["/blocked"])[0], {self.name})
            with self.assertRaisesRegex(ValueError, "Unexpected enumeration"):
                audit.inventory(self.root)
        with self.assertRaisesRegex(ValueError, "gaps changed"):
            audit.inventory(self.root, ["/blocked"])

    def test_recorded_stat_denial(self):
        from types import SimpleNamespace
        def denied(**kwargs):
            raise PermissionError(errno.EACCES, "denied")
        class Entries(list):
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
        def entries(path):
            return Entries([SimpleNamespace(path=str(self.root / "blocked"), stat=denied)])
        with patch.object(audit.os, "scandir", side_effect=entries):
            self.assertEqual(audit.inventory(self.root, ["/blocked"]), (set(), set()))
            with self.assertRaisesRegex(ValueError, "Unexpected stat"):
                audit.inventory(self.root)


if __name__ == "__main__":
    unittest.main()
