import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { deploymentSpec, imageOverride } from "../../scripts/deploy/deploy-vps.mjs";

const env = { DEPLOY_ACTION:"prepare", DEPLOY_ID:"release-20261005", DEPLOY_PORT:"8085", GITHUB_SHA:"a".repeat(40), DEPLOY_WEB_IMAGE:"kishikawakatsumi/applelocalization-web@sha256:"+"b".repeat(64) };

test("VPS inputs cannot inject shell, overwrite arbitrary paths or deploy mutable images", () => {
  assert.equal(deploymentSpec(env).project, "al-next-release-20261005");
  for (const override of [
    {DEPLOY_ACTION:"delete"}, {DEPLOY_ID:"../production"}, {DEPLOY_ID:"x;id"},
    {DEPLOY_ID:""}, {DEPLOY_PORT:"80"}, {DEPLOY_PORT:"8084"}, {DEPLOY_PORT:"8085;id"}, {DEPLOY_PORT:"65536"},
    {GITHUB_SHA:"main"}, {DEPLOY_WEB_IMAGE:"kishikawakatsumi/applelocalization-web:latest"},
    {DEPLOY_WEB_IMAGE:"other/image@sha256:"+"b".repeat(64)},
  ]) assert.throws(() => deploymentSpec({...env,...override}));
  for(const action of ["preflight","check","publish","rollback","proxy-install","proxy-status","maintenance","resume"]) assert.doesNotThrow(()=>deploymentSpec({...env,DEPLOY_ACTION:action,DEPLOY_WEB_IMAGE:""}));
  const override = imageOverride(deploymentSpec(env));
  assert.deepEqual(Object.keys(override.services), ["prepare","db","setup","web"]);
  assert.equal(override.services.web.image, env.DEPLOY_WEB_IMAGE);
  assert.equal(override.services.db.mem_limit,"2304m");
  assert.equal(override.services.db.memswap_limit,"2304m");
  assert.ok(override.services.db.command.includes("max_parallel_maintenance_workers=0"));
  assert.equal(override.services.setup.mem_limit,"384m");
});

test("workflow is manual, host-key pinned, approval-scoped, and contains no broad cleanup", async () => {
  const workflow = await readFile(".github/workflows/deploy.yml","utf8");
  const transport = await readFile("scripts/deploy/deploy-vps.mjs","utf8");
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/environment: production/);
  assert.match(workflow,/default: preflight/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,/SSH_KNOWN_HOSTS/);
  assert.doesNotMatch(workflow,/ssh-keyscan|push:|pull_request:|system prune|compose down/);
  assert.match(transport,/StrictHostKeyChecking=yes/);
  assert.match(transport,/nohup bash/);
  assert.match(transport,/mkdir \$\{directory\} && tar/);
});

test("remote scripts preserve databases and check capacity after pulling images", async () => {
  const worker = await readFile("deploy/vps.sh","utf8");
  execFileSync("bash",["-n","deploy/vps.sh"]);
  assert.match(worker,/188743680/);
  assert.match(worker,/2883584/);
  assert.match(worker,/guarded-up.py/);
  assert.ok(worker.indexOf('preflight\n# This detached') > worker.indexOf('"${compose[@]}" pull'));
  assert.match(worker,/org.opencontainers.image.revision/);
  assert.match(worker,/flock -n 9/);
  assert.doesNotMatch(worker.replace(/^\s*#.*$/gm,""),/\bprune\b|\bdown\b|\brm\b|stop db/);
});

test("preflight enforces 180 GiB plus available RAM, without changing existing services", async () => {
  const root=await mkdtemp(join(tmpdir(),"localization-preflight-test-"));
  const log=join(root,"commands.jsonl");
  await writeFile(join(root,"meminfo"),"MemTotal: 16000000 kB\nMemAvailable: 12000000 kB\n");
  const stub=`#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const tool=path.basename(process.argv[1]), a=process.argv.slice(2);
if(tool==='uname') console.log(a[0]==='-s'?'Linux':'x86_64');
if(tool==='df') console.log('Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 999999999 1 '+process.env.TEST_AVAILABLE+' 1% /fixture');
if(tool==='docker') {
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
 if(a[0]==='compose') console.log('Docker Compose version v2');
 if(a[0]==='context') console.log('unix:///fixture/docker.sock');
 if(a[0]==='info') console.log(a.at(-1).includes('OSType')?'linux':'/fixture/docker');
}
`;
  for(const name of ["docker","uname","df","flock"]) await writeFile(join(root,name),stub,{mode:0o755});
  const script=(await readFile("deploy/vps.sh","utf8")).replaceAll('/proc/meminfo',join(root,"meminfo"));
  const run=space=>execFileSync("bash",["-s","--","preflight","example"],{input:script,env:{...process.env,DOCKER_HOST:"unix:///fixture/docker.sock",TEST_AVAILABLE:String(space*1024**2),PATH:root+":"+process.env.PATH},stdio:["pipe","pipe","pipe"]});
  assert.throws(()=>run(179));
  assert.match(run(201).toString(),/Preflight passed/);
  await writeFile(join(root,"meminfo"),"MemTotal: 4000000 kB\nMemAvailable: 2300000 kB\n");
  assert.throws(()=>run(201),error=>/Need at least 3.5 GiB total/.test(error.stdout?.toString()));
  const commands=(await readFile(log,"utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(commands.every(a=>a[0]==="info"||a[0]==="context"||(a[0]==="compose"&&a[1]==="version")));
});

test("VPS HTTP checks cover all 12 scopes and reject cross-OS results", async t => {
  const seen=[];
  let bad=false;
  const server=createServer((req,res)=>{
    res.setHeader("Content-Type","application/json");
    if(req.url==="/healthz") {res.end(JSON.stringify({ready:true,datasets:12,validationOnly:false})); return;}
    const m=req.url.match(/^\/api\/(ios|macos)\/(\d+)\/search\?/);
    seen.push(m[1]+m[2]);
    res.end(JSON.stringify({data:[{dataset:bad?"wrong":m[1]+m[2]}]}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>server.close());
  const run=()=>new Promise((resolve,reject)=>{
    const p=spawn("python3",["deploy/check-vps.py",String(server.address().port)],{stdio:"ignore"});
    p.on("error",reject); p.on("exit",resolve);
  });
  assert.equal(await run(),0);
  assert.equal(new Set(seen).size,12);
  bad=true;
  assert.equal(await run(),1);
});
