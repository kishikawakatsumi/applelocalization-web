import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { psqlProcess, psqlLines } from '../scripts/occurrence-staging.mjs';
import { localDockerOnly } from '../scripts/load-occurrence-staging.mjs';
import { terminateStagingApplicationSQL } from '../scripts/staging-capacity-guard.mjs';

test('cancelling the tagged import rolls back DDL without terminating another job', {skip:process.env.LOCAL_IPSW_DB_TEST!=='1'}, async()=>{
  localDockerOnly();
  const suffix=randomUUID().replaceAll('-','');
  const application='guard_'+suffix, other='other_'+suffix;
  const schema='ipsw_trial_guard_'+suffix;
  const query=async sql=>{const rows=[];for await(const row of psqlLines(sql)) rows.push(row);return rows;};
  const previous=process.env.LOCALIZATION_STAGING_APPLICATION_NAME;
  const launch=(name,sql)=>{
    process.env.LOCALIZATION_STAGING_APPLICATION_NAME=name;
    const child=psqlProcess();
    if(previous===undefined) delete process.env.LOCALIZATION_STAGING_APPLICATION_NAME;
    else process.env.LOCALIZATION_STAGING_APPLICATION_NAME=previous;
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code));});
    child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(sql+'\n');
    return {child,done};
  };
  const target=launch(application,`BEGIN; CREATE SCHEMA ${schema}; SELECT pg_sleep(60); ROLLBACK;`);
  const unrelated=launch(other,'SELECT pg_sleep(60);');
  try {
    let ready=false;
    for(let i=0;i<30;i++) {
      if((await query(`SELECT count(*) FROM pg_stat_activity WHERE application_name IN ('${application}','${other}') AND wait_event='PgSleep'`))[0]==='2'){ready=true;break;}
      await setTimeout(100);
    }
    assert.ok(ready,'Both job sessions must reach PgSleep');
    assert.deepEqual(await query(terminateStagingApplicationSQL(application)),['t']);
    assert.notEqual(await target.done,0);
    assert.deepEqual(await query(`SELECT NOT EXISTS(SELECT FROM pg_namespace WHERE nspname='${schema}'),EXISTS(SELECT FROM pg_stat_activity WHERE application_name='${other}' AND wait_event='PgSleep')`),['t|t']);
  } finally {
    await query(terminateStagingApplicationSQL(application));
    await query(terminateStagingApplicationSQL(other));
    await Promise.all([target.done,unrelated.done]);
  }
});
