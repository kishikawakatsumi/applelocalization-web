"""HTTP-only Caddy control; no application/container/volume deletion operations."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True, timeout=180).strip()


def valid_route(route):
    if route == {"kind": "maintenance"}:
        return route
    if route.get("kind") not in ("legacy", "deployment"):
        raise ValueError("Unknown route")
    if type(route.get("port")) is not int or not 1024 <= route["port"] <= 65535:
        raise ValueError("Invalid loopback port")
    if route["kind"] == "legacy" and route["port"] != 8084:
        raise ValueError("Unexpected legacy port")
    if route["kind"] == "deployment" and not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", route.get("id", "")):
        raise ValueError("Invalid deployment ID")
    return route


def route_token(route):
    valid_route(route)
    return route["kind"] + (":" + route["id"] if route["kind"] == "deployment" else "")


def render(route, page):
    valid_route(route)
    # Unix admin socket is accessible only within the container, not via host TCP.
    config = '{\n auto_https off\n admin unix//run/caddy-admin.sock\n}\n:80 {\n'
    config += ' header X-Localization-Route ' + json.dumps(route_token(route)) + '\n'
    if route["kind"] == "maintenance":
        config += ' header Cache-Control "no-store, max-age=0"\n header Retry-After "300"\n'
        config += ' header Content-Type "text/html; charset=utf-8"\n'
        if '`' in page:
            raise ValueError("Maintenance HTML must not contain Caddy raw-string delimiters")
        config += ' respond `' + page + '` 503\n'
    else:
        config += f' reverse_proxy 127.0.0.1:{route["port"]}\n'
    return config + '}\n'


def atomic(path, text):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text)
    if path.name == "Caddyfile":
        temporary.chmod(0o644)  # Non-secret routing config, readable by constrained Caddy.
    os.replace(temporary, path)


def response(port):
    try:
        return urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=15)
    except urllib.error.HTTPError as error:
        return error


class Proxy:
    def __init__(self, root, deployments):
        self.root, self.deployments = root, deployments
        self.compose = ["docker", "compose", "--env-file", "/dev/null", "-p", "al-proxy", "-f", str(root / "compose.proxy.yml")]

    def save(self, state):
        atomic(self.root / "state.json", json.dumps(state, indent=2) + "\n")

    def container(self):
        container = run(*self.compose, "ps", "-q", "proxy")
        if not re.fullmatch(r"[a-f0-9]{64}", container):
            raise RuntimeError("Proxy is not running")
        return container

    def verify_public(self, route, check_status=True):
        with response(80) as result:
            if result.headers.get("X-Localization-Route") != route_token(route):
                raise RuntimeError("Public proxy route does not match its recorded state")
            expected = 503 if route["kind"] == "maintenance" else 200
            if check_status and result.status != expected:
                raise RuntimeError(f"Unexpected public HTTP status: {result.status}")
            if expected == 503 and (result.headers.get("Retry-After") != "300" or "no-store" not in result.headers.get("Cache-Control", "")):
                raise RuntimeError("Maintenance cache policy missing")

    def check_upstream(self, route):
        valid_route(route)
        if route["kind"] == "deployment":
            directory = self.deployments / route["id"]
            if not (directory / "ready").is_file():
                raise RuntimeError("Candidate not ready")
            metadata = json.loads((directory / "deployment.json").read_text())
            if metadata["port"] != route["port"]:
                raise RuntimeError("Candidate port mismatch")
            container = run("docker", "ps", "--no-trunc", "-q", "--filter", "label=com.docker.compose.project=al-next-" + route["id"], "--filter", "label=com.docker.compose.service=web")
            if not re.fullmatch(r"[a-f0-9]{64}", container):
                raise RuntimeError("Expected exactly one running Web for this generation")
            self.check_binding(container, route["port"], metadata["webImage"])
            run("python3", str(directory / "deploy/check-vps.py"), str(route["port"]))
        elif route["kind"] == "legacy":
            self.check_binding("applelocalization-web", route["port"])
            with response(route["port"]) as result:
                if result.status != 200:
                    raise RuntimeError("Legacy Web unavailable; cannot resume or roll back")

    def check_binding(self, container, port, image=None):
        # Inspect only non-secret fields; do not print/copy the old DB password.
        template = '{"running":{{json .State.Running}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}}}'
        info = json.loads(run("docker", "inspect", "--format", template, container))
        if not info["running"] or (image and info["image"] != image):
            raise RuntimeError("Upstream image/running state differs from the prepared generation")
        bindings = (info["ports"] or {}).get("8080/tcp") or []
        if bindings != [{"HostIp": "127.0.0.1", "HostPort": str(port)}]:
            raise RuntimeError("Upstream must own the expected loopback-only port")

    def reload(self, filename):
        run("docker", "exec", self.container(), "caddy", "reload", "--address", "unix//run/caddy-admin.sock", "--config", "/etc/localization/" + filename, "--adapter", "caddyfile")

    def transition(self, state, updated):
        self.verify_public(state["current"], check_status=False)
        self.check_upstream(updated["current"])
        active = self.root / "Caddyfile"
        previous = active.read_text()
        candidate = self.root / "candidate.Caddyfile"
        candidate.write_text(render(updated["current"], (self.root / "maintenance.html").read_text()))
        candidate.chmod(0o644)
        run("docker", "exec", self.container(), "caddy", "validate", "--config", "/etc/localization/candidate.Caddyfile", "--adapter", "caddyfile")
        # Persist before reload so a restart uses the desired route. Keep a journal
        # if the host dies between filesystem state and Caddy reload; never guess.
        atomic(self.root / "pending.json", json.dumps({"before": state, "after": updated}))
        try:
            atomic(active, candidate.read_text())
            self.reload("Caddyfile")
            self.verify_public(updated["current"])
            self.save(updated)
        except Exception:
            atomic(active, previous)
            self.reload("Caddyfile")
            self.verify_public(state["current"])
            self.save(state)
            (self.root / "pending.json").unlink()
            raise
        (self.root / "pending.json").unlink()

    def install(self):
        if (self.root / "state.json").exists():
            raise RuntimeError("Proxy already initialized")
        # No interruption of the legacy service here; port 80 must be freed by
        # the explicit one-time legacy loopback migration in the runbook.
        import platform
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            raise RuntimeError("A Linux x86_64 VPS is required")
        endpoint = os.environ.get("DOCKER_HOST") or run("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
        if not endpoint.startswith("unix://"):
            raise RuntimeError("Local Docker required")
        if run("ss", "-H", "-ltn", "sport = :80"):
            raise RuntimeError("Port 80 is in use; migrate the legacy Web to loopback first")
        self.check_upstream({"kind": "legacy", "port": 8084})
        self.root.chmod(0o755)
        state = {"current": {"kind": "legacy", "port": 8084}, "previous": None, "resume": None}
        atomic(self.root / "Caddyfile", render(state["current"], (self.root / "maintenance.html").read_text()))
        run(*self.compose, "pull")
        run(*self.compose, "up", "-d")
        for attempt in range(20):
            try:
                self.verify_public(state["current"])
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(1)
        self.save(state)

    def act(self, action, deployment_id):
        if action == "proxy-install":
            self.install()
            return
        state = json.loads((self.root / "state.json").read_text())
        if (self.root / "pending.json").exists():
            raise RuntimeError("Interrupted proxy change: reconcile pending.json, Caddyfile and live route before continuing")
        if action == "proxy-status":
            self.verify_public(state["current"])
            print(json.dumps(state))
            return
        updated = dict(state)
        if action == "maintenance":
            if state["current"]["kind"] == "maintenance":
                self.verify_public(state["current"])
                return
            updated.update(current={"kind": "maintenance"}, resume=state["current"])
        elif action == "resume":
            if state["current"]["kind"] != "maintenance" or not state["resume"]:
                raise RuntimeError("No suspended route")
            updated.update(current=state["resume"], resume=None)
        elif action == "publish":
            directory = self.deployments / deployment_id
            metadata = json.loads((directory / "deployment.json").read_text())
            target = {"kind": "deployment", "id": deployment_id, "port": metadata["port"]}
            if state["current"] == target:
                self.verify_public(target)
                return
            # Maintenance remains the rollback destination after a space-saving
            # migration: the deleted old database must never be presumed usable.
            updated.update(current=target, previous=state["current"], resume=None)
        elif action == "rollback":
            if state["current"].get("id") != deployment_id or not state["previous"]:
                raise RuntimeError("This deployment is not currently published or has no rollback route")
            updated.update(current=state["previous"], previous=None, resume=None)
        else:
            raise ValueError("Unknown proxy action")
        self.transition(state, updated)
        print(json.dumps(updated))


def main():
    action, deployment_id = sys.argv[1:]
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", deployment_id):
        raise ValueError("Invalid deployment ID")
    os.umask(0o077)
    root = Path.home() / "applelocalization-proxy"
    with (root / "control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Proxy(root, Path.home() / "applelocalization-deployments").act(action, deployment_id)


if __name__ == "__main__":
    main()
