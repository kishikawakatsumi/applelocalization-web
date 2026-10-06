import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("proxy", Path(__file__).resolve().parents[2] / "deploy/proxy-vps.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
LEGACY = {"kind": "legacy", "port": 8084}
MAINTENANCE = {"kind": "maintenance"}


class FakeProxy(proxy.Proxy):
    def container(self):
        return "a" * 64

    def verify_public(self, route, check_status=True):
        assert self.live == proxy.render(route, "Maintenance")

    def check_upstream(self, route):
        proxy.valid_route(route)
        if route["kind"] == "legacy" and self.legacy_deleted:
            raise RuntimeError("Legacy database deleted")

    def reload(self, filename):
        if self.fail_reload:
            self.fail_reload = False
            raise RuntimeError("Reload failed")
        self.live = (self.root / filename).read_text()


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.p = FakeProxy(root, root / "deployments")
        self.p.legacy_deleted = False
        self.p.fail_reload = False
        self.p.live = proxy.render(LEGACY, "Maintenance")
        (root / "Caddyfile").write_text(self.p.live)
        (root / "maintenance.html").write_text("Maintenance")
        self.p.save({"current": LEGACY, "previous": None, "resume": None})
        for name, port in [("first", 8085), ("second", 8086)]:
            d = self.p.deployments / name
            d.mkdir(parents=True)
            (d / "deployment.json").write_text(json.dumps({"port": port}))
        mock = patch.object(proxy, "run", return_value="")
        mock.start()
        self.addCleanup(mock.stop)

    def state(self):
        return json.loads((self.p.root / "state.json").read_text())

    def test_maintenance_resume(self):
        self.p.act("maintenance", "first")
        self.assertEqual(self.state()["current"], MAINTENANCE)
        self.assertEqual(self.state()["resume"], LEGACY)
        self.p.act("maintenance", "first")
        self.assertEqual(self.state()["resume"], LEGACY)
        self.p.act("resume", "first")
        self.assertEqual(self.state()["current"], LEGACY)

    def test_multiple_generations_rollback(self):
        self.p.act("publish", "first")
        self.p.act("publish", "first")  # Idempotent; rollback target preserved.
        self.assertEqual(self.state()["previous"], LEGACY)
        self.p.act("publish", "second")
        with self.assertRaises(RuntimeError):
            self.p.act("rollback", "first")
        self.p.act("rollback", "second")
        self.assertEqual(self.state()["current"]["id"], "first")

    def test_deleted_legacy_does_not_get_resurrected(self):
        self.p.act("maintenance", "first")
        self.p.legacy_deleted = True
        with self.assertRaises(RuntimeError):
            self.p.act("resume", "first")
        self.assertEqual(self.state()["current"], MAINTENANCE)
        self.p.act("publish", "first")
        self.p.act("rollback", "first")
        self.assertEqual(self.state()["current"], MAINTENANCE)
        self.assertIsNone(self.state()["resume"])

    def test_failed_reload_restores_live_and_disk_state(self):
        before = self.state()
        self.p.fail_reload = True
        with self.assertRaises(RuntimeError):
            self.p.act("publish", "first")
        self.assertEqual(self.state(), before)
        self.assertEqual((self.p.root / "Caddyfile").read_text(), self.p.live)
        self.assertFalse((self.p.root / "pending.json").exists())

    def test_interrupted_change_refuses_further_changes(self):
        (self.p.root / "pending.json").write_text("{}")
        with self.assertRaises(RuntimeError):
            self.p.act("publish", "first")

    def test_unsafe_routes_rejected(self):
        for route in [dict(kind="other"), dict(kind="legacy", port=80), dict(kind="deployment", id="../x", port=8085), dict(kind="deployment", id="ok", port="80;id")]:
            with self.assertRaises(ValueError):
                proxy.render(route, "Maintenance")
        text = proxy.render(MAINTENANCE, "Maintenance")
        self.assertIn(' 503', text)
        self.assertIn('no-store', text)
        self.assertIn('Retry-After "300"', text)
        self.assertNotIn('reverse_proxy', text)

    def test_binding_must_belong_to_the_expected_generation(self):
        info = {"running": True, "image": "pinned-image", "ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8085"}]}}
        with patch.object(proxy, "run", return_value=json.dumps(info)):
            self.p.check_binding("container", 8085, "pinned-image")
            with self.assertRaises(RuntimeError):
                self.p.check_binding("container", 8086, "pinned-image")
            with self.assertRaises(RuntimeError):
                self.p.check_binding("container", 8085, "different-image")
        info["ports"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
        with patch.object(proxy, "run", return_value=json.dumps(info)):
            with self.assertRaises(RuntimeError):
                self.p.check_binding("container", 8085, "pinned-image")


if __name__ == "__main__":
    unittest.main()
