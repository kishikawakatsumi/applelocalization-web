// Opt-in: 144 synthetic occurrences, isolated project, no real data download.
// Retains stopped containers/volumes and diagnostics, including on failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { batch } from "../scripts/candidate-pipeline.mjs";
import { releaseCatalog } from "../scripts/compose-release-set.mjs";
import { occurrenceSQLLayout } from "../scripts/occurrence-staging.mjs";
import { sha256 } from "../scripts/collection-checkpoints.mjs";
import { imageOverride } from "../scripts/deploy-vps.mjs";

assert.equal(process.env.ALLOW_COMPOSE_TEST, "1");
const root = await mkdtemp(join(tmpdir(), "localization-compose-"));
const project = "localization-compose-test-" + randomBytes(6).toString("hex");
const image = project + ":fixture";
const platform = process.env.COMPOSE_TEST_PLATFORM ?? "linux/amd64";
const lowMemory = process.env.COMPOSE_TEST_LOW_MEMORY === "1";
assert.ok(["linux/amd64", "linux/arm64"].includes(platform));
const base = process.env.COMPOSE_TEST_BASE ?? "groonga/pgroonga:4.0.4-alpine-16-slim";
assert.match(base, /^(groonga\/pgroonga:[a-zA-Z0-9.-]+|sha256:[a-f0-9]{64})$/);
const docker = (args, input) => execFileSync("docker", args, {
  input, encoding:"utf8", timeout:600000, maxBuffer:16*1024**2,
  env:{...process.env,WEB_PORT:"0"},
}).trim();
const payload = join(root, "payload");
await mkdir(join(payload, "bundles"), {recursive:true});
const quote = s => "'" + String(s).replaceAll("'", "''") + "'";
const bundles = [];
let sql = "CREATE EXTENSION IF NOT EXISTS pgroonga;\n";
const sources = [];
for (const target of batch.targets) {
  const components = [];
  for (const job of batch.jobs.filter(j=>j.target===target.id)) {
    const sourceId = `${target.platform}-${target.version}-${target.build}-${job.key}`;
    const report = JSON.stringify({formatVersion:1,outputKind:"localization-occurrence-package",status:"prepared-not-imported",sourceId});
    const manifest = sha256(report);
    const c = {...job,sourceId,rows:4,packageManifest:manifest,sqlSha256:"a".repeat(64),sqlReportSha256:"b".repeat(64)};
    components.push(c);
    sources.push([c.key,c.schema,manifest].join("\t"));
    const s=c.schema, layout=occurrenceSQLLayout({schema:s,durable:true,database:"localization_staging",searchIndexVersion:1});
    sql += layout.header + "\n";
    sql += `INSERT INTO ${s}.package VALUES(1,${quote(manifest)},${quote(report)},${quote(JSON.stringify({sourceId}))});\n`;
    sql += `INSERT INTO ${s}.source VALUES(1,'{}'); INSERT INTO ${s}.bundle VALUES(1,'/Example.app'); INSERT INTO ${s}.resource_table VALUES(1,'table','{}');\n`;
    for (const [id,code] of [[1,"en"],[2,"ja"]]) {
      const metadata=JSON.stringify({sourceId,original:{imagePath:`/Example.app/${code}.lproj/Main.strings`,resourcePath:`${code}.lproj/Main.strings`,bundleName:"Example.app"}});
      sql += `INSERT INTO ${s}.resource VALUES(${id},'resource-${code}',1,1,'indexed',2,${quote(metadata)});\n`;
      sql += `INSERT INTO ${s}.language VALUES(${id},'${code}','${code}','lproj','identified',2);\n`;
      sql += `INSERT INTO ${s}.occurrence VALUES(${id*2-1},${id},1,${id},'Open',NULL,'text',${quote(code==="en"?"Open":"開く")},NULL);\n`;
      sql += `INSERT INTO ${s}.occurrence VALUES(${id*2},${id},2,${id},'Count',NULL,'structured',NULL,${quote(JSON.stringify({one:code==="en"?"One item":"一件",other:"%d"}))});\n`;
    }
    sql += layout.footer + "\n";
  }
  bundles.push({formatVersion:1,status:"candidate-sql-bundle-verified",target,components,apiCompatible:false,productionReady:false,published:false});
}
const inputs=[];
for(const b of bundles) {
  const bytes=JSON.stringify(b);
  await writeFile(join(payload,"bundles",b.target.id+".json"),bytes);
  inputs.push({target:b.target.id,bundleSha256:sha256(bytes)});
}
const catalog={...releaseCatalog(bundles),inputs};
await writeFile(join(payload,"release-set.json"),JSON.stringify(catalog));
await writeFile(join(payload,"import.sql"),sql);
await writeFile(join(payload,"identity"),sha256(sql)+"\n");
await writeFile(join(payload,"dataset.env"),"DATASET_DATABASE=localization_staging\n");
await writeFile(join(payload,"sources.tsv"),sources.join("\n")+"\n");
await writeFile(join(payload,"SHA256SUMS"),sha256(sql)+"  import.sql\n");
for(const [from,to] of [
  ["scripts/templates/candidate-bundle/localization-entrypoint.sh","entrypoint.sh"],
  ["scripts/templates/candidate-bundle/postgres-init-entrypoint.sh","postgres-init-entrypoint.sh"],
  ["scripts/templates/candidate-bundle/healthcheck.sh","healthcheck.sh"],
])await copyFile(from,join(root,to));
await writeFile(join(root,"init.sh"),`#!/usr/bin/env bash
set -Eeuo pipefail
psql -X -v ON_ERROR_STOP=1 -U postgres -d localization_staging -f /opt/localization/import.sql
cp /opt/localization/identity "$PGDATA/.localization-ready"
`);
await writeFile(join(root,"Dockerfile"),`FROM ${base}
RUN mv /usr/local/bin/docker-entrypoint.sh /usr/local/bin/postgres-upstream-entrypoint.sh
COPY payload/ /opt/localization/
COPY postgres-init-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY entrypoint.sh /usr/local/bin/localization-entrypoint.sh
COPY healthcheck.sh /usr/local/bin/localization-healthcheck.sh
COPY init.sh /docker-entrypoint-initdb.d/10-localization.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/localization-entrypoint.sh /usr/local/bin/localization-healthcheck.sh /docker-entrypoint-initdb.d/10-localization.sh
ENTRYPOINT ["/usr/local/bin/localization-entrypoint.sh"]
CMD ["postgres"]
`);
// The real 200 GiB threshold is replaced ONLY in this generated tiny fixture.
const prepare=await readFile("deploy/prepare.sh","utf8");
assert.ok(prepare.includes("209715200"));
await writeFile(join(root,"prepare.sh"),prepare.replace("209715200","1024")
  .replace("188743680","1024")
  .replace("fb53fa63afc4ad9850991e56ef0222574371e1cdb5eee228dda1f7b5e1843fc9",sha256(sql)));
const override=join(root,"override.json");
const profile=lowMemory?imageOverride({webImage:"applelocalization-web:cleanup-test"}).services:{};
await writeFile(override,JSON.stringify({services:{
  prepare:{...profile.prepare,image,platform,volumes:[{type:"bind",source:join(root,"prepare.sh"),target:"/prepare.sh",read_only:true}]},
  db:{...profile.db,image,platform,healthcheck:{interval:"1s",timeout:"5s",start_period:"2m",retries:3}},
  setup:{...profile.setup,platform,image:"applelocalization-web:cleanup-test"},
  web:{...profile.web,platform,image:"applelocalization-web:cleanup-test",healthcheck:{interval:"1s",timeout:"5s",start_period:"30s",retries:3}},
}}));
const args=["compose","-p",project,"-f",resolve("compose.yml"),"-f",override];
const compose=(tail)=>docker([...args,...tail]);
console.log(JSON.stringify({project,diagnostics:root,syntheticRows:144}));
let started=false;
try {
  docker(["build","--platform",platform,"-t",image,root]);
  started=true;
  compose(["up","-d","--no-build","--wait","--wait-timeout","240"]);
  let baseURL="http://"+compose(["port","web","8080"]);
  const health=await(await fetch(baseURL+"/healthz")).json();
  assert.deepEqual(health,{ready:true,datasets:12,validationOnly:false});
  const request=async path=>{
    const r=await fetch(baseURL+path,{headers:{Connection:"close"}});assert.equal(r.status,200,await r.clone().text());return r.json();
  };
  assert.equal((await request("/openapi.json")).openapi,"3.1.1");
  for(const path of ["/llms.txt","/docs/agent-access.md","/skills/apple-localization/SKILL.md"]){
    const response=await fetch(baseURL+path);
    assert.equal(response.status,200);assert.ok((await response.text()).length>0);
  }
  const mcp=async(method,params,id=1)=>{
    const response=await fetch(baseURL+"/mcp",{method:"POST",headers:{
      "Content-Type":"application/json",Accept:"application/json, text/event-stream",
      "MCP-Protocol-Version":"2025-11-25",Connection:"close",
    },body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
    assert.equal(response.status,200,await response.clone().text());
    const body=await response.json();assert.ok(!body.error,JSON.stringify(body));return body.result;
  };
  assert.ok((await mcp("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"compose-test",version:"1"}})).capabilities.tools);
  assert.equal((await mcp("tools/list",{})).tools.length,3);
  for(const platform of ["ios","macos"]){
    const result=await mcp("tools/call",{name:"search_translations",arguments:{platform,major:27,query:"Open",languages:["English","Japanese"],limit:20}});
    assert.ok(!result.isError,JSON.stringify(result));
    assert.equal(result.structuredContent.dataset.id,platform+"27");
    assert.ok(result.structuredContent.rows.length>0);
    assert.ok(result.structuredContent.rows.every(row=>row.component.startsWith(platform+"27-")));
  }
  for(const d of catalog.datasets){
    const path=`/api/${d.platform.toLowerCase()}/${d.version.split(".")[0]}/search`;
    const r=await request(path+"?q="+encodeURIComponent("開く")+"&l=English&l=Japanese");
    assert.equal(r.total,d.components.length*2);
    assert.ok(r.data.every(x=>x.dataset===d.id));
    const structured=await request(path+"?q="+encodeURIComponent("一件"));
    assert.ok(structured.total>0);
  }
  const before=await request("/api/macos/26/search?q=Open");
  const db=compose(["ps","-q","db"]);
  const query=s=>docker(["exec","-i",db,"psql","-X","-v","ON_ERROR_STOP=1","-U","postgres","-d","localization_staging","-At"],s);
  if(lowMemory){
    assert.equal(query("SHOW shared_buffers; SHOW maintenance_work_mem; SHOW max_parallel_maintenance_workers; SHOW max_connections;"),"128MB\n64MB\n0\n40");
    assert.equal(docker(["inspect","--format","{{.HostConfig.Memory}}",db]),String(2304*1024**2));
    assert.equal(docker(["inspect","--format","{{.HostConfig.MemorySwap}}",db]),String(2304*1024**2));
  }
  const role="web_"+sha256(JSON.stringify(catalog)).slice(0,24);
  assert.equal(query(`SELECT has_table_privilege('${role}','${catalog.datasets[0].components[0].schema}.occurrence','INSERT');`),"f");
  compose(["stop"]);
  compose(["up","-d","--no-build","--wait","--wait-timeout","240"]);
  baseURL="http://"+compose(["port","web","8080"]);
  assert.deepEqual(await request("/api/macos/26/search?q=Open"),before);
  // Identity mismatch must fail before copying metadata or issuing SQL.
  compose(["run","--rm","--no-deps","--entrypoint","sh","prepare","-c","printf wrong > /release/identity"]);
  assert.throws(()=>compose(["run","--rm","--no-deps","prepare"]));
  console.log("COMPOSE_STARTUP_VERIFIED: 12 scopes, JSON search, read-only role, restart, mismatched release refusal");
} finally {
  if(started){
    await writeFile(join(root,"compose.log"),compose(["logs","--no-color"]).slice(-4*1024**2));
    compose(["stop"]);
  }
  console.log("Stopped fixture retained at "+root);
}
