import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";

test("restore supervisor handles resource pressure, OOM, failure and cancellation",()=>{
  execFileSync("python3",["-B","tests/vps_resources.py"],{stdio:"pipe"});
});
test("lower capacity gate is restricted to the measured dataset, default stays 200 GiB",async()=>{
  const prepare=await readFile("deploy/prepare.sh","utf8");
  assert.match(prepare,/minimum_kib=209715200/);
  assert.match(prepare,/vps-4g\)[\s\S]*fb53fa63afc4ad9850991e56ef0222574371e1cdb5eee228dda1f7b5e1843fc9[\s\S]*minimum_kib=188743680/);
  assert.match(prepare,/Unknown restore capacity profile/);
  const worker=await readFile("deploy/vps.sh","utf8");
  assert.ok(worker.indexOf('test ! -e started') < worker.indexOf('python3 deploy/guarded-up.py'));
  assert.ok(worker.indexOf('python3 deploy/guarded-up.py') < worker.indexOf('touch ready'));
});
