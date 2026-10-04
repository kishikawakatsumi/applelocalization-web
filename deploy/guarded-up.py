"""Bounded restore supervisor: monitor host resources, stop ONLY its new project."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

GIB = 1024 ** 3
MIB = 1024 ** 2


def memory_available(text):
    match = re.search(r"^MemAvailable:\s+(\d+) kB$", text, re.M)
    if not match:
        raise ValueError("Cannot read available memory")
    return int(match[1]) * 1024


def check_sample(sample):
    if sample["diskBytes"] < 20 * GIB:
        raise RuntimeError("Free Docker disk fell below 20 GiB")
    if sample["memoryBytes"] < 256 * MIB:
        raise RuntimeError("Available host RAM fell below 256 MiB")
    if sample["oomKilled"]:
        raise RuntimeError("New deployment container was OOM-killed")
    if sample.get("restarted"):
        raise RuntimeError("New deployment container restarted unexpectedly")


def owned_container(info, project):
    labels = info.get("labels") or {}
    if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") not in ("prepare", "db", "setup", "web"):
        raise RuntimeError("Refusing an unrelated container")


def inspect_states(compose, project):
    ids = subprocess.check_output(compose + ["ps", "-a", "-q"], text=True, timeout=20).split()
    states = []
    for container in ids:
        if not re.fullmatch(r"[a-f0-9]{64}", container):
            raise RuntimeError("Unexpected container ID")
        text = subprocess.check_output(["docker", "inspect", "--format", '{"labels":{{json .Config.Labels}},"state":{{json .State}},"restarts":{{.RestartCount}}}', container], text=True, timeout=20)
        info = json.loads(text)
        owned_container(info, project)
        states.append({**info["state"], "restarts": info["restarts"]})
    return states


def supervise(compose, sample, process_factory=subprocess.Popen, stop=subprocess.run, pause=time.sleep):
    # Check again immediately before starting any containers.
    check_sample(sample())
    child = process_factory(compose + ["up", "-d", "--no-build", "--wait", "--wait-timeout", "86400"])
    try:
        while True:
            check_sample(sample())
            code = child.poll()
            if code is not None:
                if code != 0:
                    raise RuntimeError(f"Compose initialization failed: {code}")
                return
            pause(10)
    except BaseException:
        # Stop the orchestration first, so it cannot start services after our stop.
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
        result = stop(compose + ["stop", "--timeout", "30"], timeout=180)
        if result.returncode:
            print("URGENT: new deployment could not be stopped; inspect VPS immediately", file=sys.stderr)
        raise


def main():
    deployment_id, docker_root = sys.argv[1:]
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", deployment_id):
        raise ValueError("Invalid deployment ID")
    root = Path.home() / "applelocalization-deployments" / deployment_id
    if Path.cwd().resolve() != root.resolve() or (root / "ready").exists():
        raise RuntimeError("Only a fresh, unpublished deployment can be supervised")
    metadata = json.loads((root / "deployment.json").read_text())
    if metadata["id"] != deployment_id or metadata["project"] != "al-next-" + deployment_id:
        raise RuntimeError("Project identity mismatch")
    project = metadata["project"]
    compose = ["docker", "compose", "--env-file", "/dev/null", "-p", project, "-f", "compose.yml", "-f", "images.json"]

    def sample():
        disk = os.statvfs(docker_root)
        states = inspect_states(compose, project)
        result = {"time": time.time(), "diskBytes": disk.f_bavail * disk.f_frsize,
                  "memoryBytes": memory_available(Path("/proc/meminfo").read_text()),
                  "oomKilled": any(s.get("OOMKilled") for s in states),
                  "restarted": any(s["restarts"] for s in states)}
        with (root / "capacity.jsonl").open("a") as output:
            output.write(json.dumps(result) + "\n")
        return result

    def interrupted(signum, frame):
        raise RuntimeError(f"Restore supervisor interrupted ({signum})")

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        supervise(compose, sample)
    except BaseException:
        (root / "failed").touch()
        raise


if __name__ == "__main__":
    main()
