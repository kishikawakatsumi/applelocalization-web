import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";

test("proxy route transactions, maintenance and rollback (no real Docker)",()=>{
  execFileSync("python3",["-B","tests/proxy_vps.py"],{stdio:"pipe"});
});
test("HTTP proxy is independent and has no TCP admin listener or application deletion",async()=>{
  const compose=await readFile("deploy/compose.proxy.yml","utf8");
  const controller=await readFile("deploy/proxy-vps.py","utf8");
  assert.match(compose,/caddy:.*@sha256:[a-f0-9]{64}/);
  assert.match(compose,/network_mode: host/);
  assert.doesNotMatch(compose,/docker.sock|database:|admin-secret|app-secret|depends_on/);
  assert.match(controller,/admin unix\/\/run\/caddy-admin.sock/);
  assert.match(controller,/auto_https off/);
  assert.doesNotMatch(controller,/"(?:stop|down|rm|prune)"/);
  const driver=await readFile("scripts/deploy-vps.mjs","utf8");
  assert.match(driver,/if \(!installingProxy\) run\("preflight"\)/);
});
