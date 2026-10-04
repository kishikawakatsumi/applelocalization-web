import test from "node:test";
import assert from "node:assert/strict";
import {readFile,access,readdir} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";

test("verified localization data is excluded from automated image replacement",async()=>{
  const config=JSON.parse(await readFile(".github/renovate.json","utf8"));
  const rules=config.packageRules.filter(rule=>rule.matchPackageNames?.includes("kishikawakatsumi/applelocalization-data"));
  assert.ok(rules.length>0);
  assert.equal(rules.at(-1).enabled,false);
});

test("default deployment is self-contained, digest-pinned, persistent and loopback-only",async()=>{
  const compose=await readFile("compose.yml","utf8");
  assert.match(compose,/applelocalization-data@sha256:[a-f0-9]{64}/);
  assert.match(compose,/127\.0\.0\.1:/);
  assert.match(compose,/service_completed_successfully/);
  assert.match(compose,/internal: true/);
  assert.doesNotMatch(compose,/external: true|container_name:|POSTGRES_PASSWORD:|:latest/);
  const web=compose.slice(compose.indexOf("  web:"), compose.indexOf("\nnetworks:"));
  assert.doesNotMatch(web,/admin-secret:/);
  const prepare=await readFile("deploy/prepare.sh","utf8");
  assert.match(prepare,/209715200/);
  assert.match(prepare,/Existing database credentials are missing/);
  assert.match(prepare,/Different release volume/);
  await assert.rejects(access("docker-compose.yml"));
});
test("runtime build has no private registry or legacy entry points",async()=>{
  const docker=await readFile("Dockerfile","utf8"),pkg=JSON.parse(await readFile("package.json"));
  assert.match(docker,/npm ci/);
  assert.match(docker,/backend\/main.ts/);
  assert.doesNotMatch(docker,/FONTAWESOME_TOKEN|ARG.*TOKEN|COPY scripts \.\/scripts/);
  assert.ok(Object.keys(pkg.dependencies).every(x=>!x.startsWith("@fortawesome/pro-")));
  const lock=await readFile("package-lock.json","utf8");
  assert.doesNotMatch(lock,/npm.fontawesome.com/);
});

test("retained source imports and workflow entry points exist after cleanup",async()=>{
  const walk=async dir=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]))).flat();
  for(const file of (await Promise.all(["backend","frontend","scripts","tests","deploy"].map(walk))).flat().filter(p=>/\.(?:[cm]?js|ts)$/.test(p))){
    const text=await readFile(file,"utf8");
    for(const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)["'](\.[^"']+)["']/g)){
      const path=resolve(dirname(file),m[1]);
      const found=await Promise.all([path,path+".js",path+".mjs",path+".ts"].map(p=>access(p).then(()=>true,()=>false)));
      assert.ok(found.some(Boolean),file+" imports missing "+m[1]);
    }
  }
  for(const file of await walk(".github/workflows")){
    for(const m of (await readFile(file,"utf8")).matchAll(/\b(?:scripts|tests)\/[A-Za-z0-9_.\/-]+\.(?:mjs|ts|py)\b/g)) await access(m[0]);
  }
});
