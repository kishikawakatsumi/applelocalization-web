// Opt-in real Caddy test. Tiny fake upstreams only; no actual DB/VPS connection.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,rename,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomBytes} from "node:crypto";

assert.equal(process.env.ALLOW_PROXY_TEST,"1");
const root=await mkdtemp(join(tmpdir(),"localization-proxy-"));
await chmod(root,0o755);
const name="localization-proxy-test-"+randomBytes(6).toString("hex");
const compose=await readFile("deploy/compose.proxy.yml","utf8");
const image=compose.match(/image: (\S+)/)[1];
const html=await readFile("deploy/maintenance.html","utf8");
const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",timeout:180000,stdio:["pipe","pipe","pipe"]}).trim();
const render=route=>execFileSync("python3",["-B","-c",`import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('p',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.render(json.loads(sys.argv[2]),Path(sys.argv[3]).read_text()),end='')`,resolve("deploy/proxy-vps.py"),JSON.stringify(route),resolve("deploy/maintenance.html")],{encoding:"utf8"});
const maintenance={kind:"maintenance"};
await writeFile(join(root,"Caddyfile"),render(maintenance));
await writeFile(join(root,"upstreams.json"),JSON.stringify({admin:{disabled:true},apps:{http:{servers:Object.fromEntries([8084,8085].map(port=>[String(port),{listen:[`127.0.0.1:${port}`],routes:[{handle:[{handler:"static_response",body:`upstream-${port}: {http.request.uri}`}]}]}]))}}}));
let started=false;
try {
  docker("run","-d","--name",name,"--read-only","--tmpfs","/run","--tmpfs","/tmp","--tmpfs","/config","--tmpfs","/data","--cap-drop","ALL","--cap-add","NET_BIND_SERVICE","--security-opt","no-new-privileges:true","-p","127.0.0.1::80","--mount",`type=bind,source=${root},target=/etc/localization,readonly`,image,"caddy","run","--config","/etc/localization/Caddyfile","--adapter","caddyfile");
  started=true;
  let base="http://"+docker("port",name,"80/tcp");
  const request=path=>fetch(base+path,{headers:{Connection:"close"}});
  let ready=false;
  for(let attempt=0;attempt<30;attempt++) {
    try {const r=await request("");if(r.status===503){ready=true;break;}} catch {}
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(ready,"Caddy startup");
  const verifyMaintenance=async()=>{
    const r=await request("/api/ios/27/search?q=Open");
    assert.equal(r.status,503);assert.equal(r.headers.get("retry-after"),"300");
    assert.match(r.headers.get("cache-control"),/no-store/);
    assert.equal(r.headers.get("x-localization-route"),"maintenance");
    assert.equal(await r.text(),html);
  };
  await verifyMaintenance();
  docker("exec","-d",name,"caddy","run","--config","/etc/localization/upstreams.json");
  await new Promise(r=>setTimeout(r,500));
  const reload=async route=>{
    await writeFile(join(root,"next.Caddyfile"),render(route));
    docker("exec",name,"caddy","validate","--config","/etc/localization/next.Caddyfile","--adapter","caddyfile");
    await rename(join(root,"next.Caddyfile"),join(root,"Caddyfile"));
    docker("exec",name,"caddy","reload","--address","unix//run/caddy-admin.sock","--config","/etc/localization/Caddyfile","--adapter","caddyfile");
  };
  const path="/macos/27?q=a%26b%2Bc&l=English&l=Japanese";
  for(const route of [{kind:"legacy",port:8084},{kind:"deployment",id:"new",port:8085},{kind:"legacy",port:8084}]) {
    await reload(route);
    const r=await request(path);assert.equal(r.status,200);
    assert.equal(r.headers.get("x-localization-route"),route.kind+(route.id?":"+route.id:""));
    assert.equal(await r.text(),`upstream-${route.port}: ${path}`);
  }
  await writeFile(join(root,"invalid.Caddyfile"),"invalid directive {{{");
  assert.throws(()=>docker("exec",name,"caddy","reload","--address","unix//run/caddy-admin.sock","--config","/etc/localization/invalid.Caddyfile","--adapter","caddyfile"));
  assert.equal((await request("")).status,200);
  await reload(maintenance);
  await verifyMaintenance();
  docker("restart",name);
  // Docker may allocate a different ephemeral host port on restart.
  base="http://"+docker("port",name,"80/tcp");
  for(let attempt=0;attempt<30;attempt++) {
    try {const r=await request("");if(r.status===503) break;} catch {}
    await new Promise(r=>setTimeout(r,250));
  }
  await verifyMaintenance();
  console.log("PROXY_VERIFIED: HTTP routing, query preservation, rollback, invalid-config refusal, 503/no-store/Retry-After, restart persistence");
} finally {
  if(started){
    await writeFile(join(root,"container.log"),docker("logs",name));
    docker("stop",name);
  }
  console.log(`Stopped fixture retained: ${name}; ${root}`);
}
