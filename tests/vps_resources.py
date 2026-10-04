import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).resolve().parents[1] / "deploy/guarded-up.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Child:
    def __init__(self, code=None):
        self.code = code
        self.terminated = False

    def poll(self):
        return self.code

    def terminate(self):
        self.terminated = True
        self.code = -15

    def wait(self, **kwargs):
        return self.code


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.good = dict(diskBytes=50*guard.GIB, memoryBytes=guard.GIB, oomKilled=False)
        self.compose = ["docker", "compose", "-p", "al-next-example", "-f", "compose.yml", "-f", "images.json"]

    def test_thresholds(self):
        guard.check_sample(self.good)
        for change in [dict(diskBytes=19*guard.GIB), dict(memoryBytes=255*guard.MIB), dict(oomKilled=True), dict(restarted=True)]:
            with self.assertRaises(RuntimeError):
                guard.check_sample({**self.good, **change})
        with self.assertRaises(ValueError):
            guard.memory_available("invalid")
        self.assertEqual(guard.memory_available("MemAvailable: 2048 kB\n"), 2048*1024)

    def test_only_project_owned_containers(self):
        guard.owned_container(dict(labels={"com.docker.compose.project":"al-next-example", "com.docker.compose.service":"db"}), "al-next-example")
        for project, service in [("old-production", "db"), ("al-next-example", "other")]:
            with self.assertRaises(RuntimeError):
                guard.owned_container(dict(labels={"com.docker.compose.project":project,"com.docker.compose.service":service}), "al-next-example")

    def test_success_does_not_stop(self):
        calls=[]
        guard.supervise(self.compose, lambda:self.good, process_factory=lambda args:Child(0), stop=lambda *a,**k:calls.append(a))
        self.assertEqual(calls, [])

    def test_pressure_stops_only_new_project_after_terminating_cli(self):
        for change in [dict(diskBytes=1), dict(memoryBytes=1), dict(oomKilled=True), dict(restarted=True)]:
            samples=iter([self.good,{**self.good,**change}])
            child=Child()
            stopped=[]
            def stop(args, **kwargs):
                self.assertTrue(child.terminated)
                stopped.append(args)
                return SimpleNamespace(returncode=0)
            with self.assertRaises(RuntimeError):
                guard.supervise(self.compose,lambda:next(samples),process_factory=lambda args:child,stop=stop)
            self.assertEqual(stopped,[self.compose+["stop","--timeout","30"]])

    def test_initial_failure_never_starts_containers(self):
        with self.assertRaises(RuntimeError):
            guard.supervise(self.compose,lambda:{**self.good,"diskBytes":0},process_factory=lambda args:self.fail("must not start"))

    def test_compose_failure_and_interrupt_both_stop(self):
        for interrupt in [False,True]:
            stopped=[]
            child=Child(None if interrupt else 1)
            def stop(args,**kwargs):
                stopped.append(args)
                return SimpleNamespace(returncode=0)
            def pause(seconds):
                raise KeyboardInterrupt()
            with self.assertRaises((RuntimeError,KeyboardInterrupt)):
                guard.supervise(self.compose,lambda:self.good,process_factory=lambda args:child,stop=stop,pause=pause)
            self.assertEqual(len(stopped),1)


if __name__ == "__main__":
    unittest.main()
