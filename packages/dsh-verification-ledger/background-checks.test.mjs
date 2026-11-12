import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyJob, createBackgroundChecks } from './background-checks.mjs';
const grant={sessionId:'s',root:'/root',command:'node --test'};
const view={id:'bash-job',owner:'s',kind:'bash',label:'node --test',status:'running',output:{total:0,earliest:0}};
test('only exact owned Bash producer settlement establishes terminal exit status',()=>{
  assert.equal(classifyJob(grant,view,'producer'),null);
  assert.equal(classifyJob(grant,{...view,status:'completed',detail:'exit code: 0'},'producer').exitCode,0);
  assert.equal(classifyJob(grant,{...view,status:'completed',detail:'exit code: 3'},'producer').exitCode,3);
  for(const job of [{...view,owner:'other'},{...view,status:'killed',detail:'exit code: 0'},{...view,status:'completed',detail:'printed success'}])assert.equal(classifyJob(grant,job,'producer').settled,false);
  assert.equal(classifyJob(grant,{...view,status:'completed',detail:'exit code: 0'},'owner-dispose').settled,false);
});
test('pending binds first and observer captures without consuming model cursor or waiting',async()=>{
  let callback;const order=[];let reads=0;
  const jobs={get:()=>view,readAt:(_id,from,caller)=>{assert.equal(from,0);assert.equal(caller,'s');reads++;return{chunks:[{channel:'stdout',text:'result'}],lossy:false};},events:{subscribe:(_filter,fn)=>{callback=fn;return()=>{};}}};
  const tracker=createBackgroundChecks(jobs,{pending:async()=>order.push('pending'),complete:async(_grant,outcome)=>{order.push(outcome.exitCode===0?'pass':'fail');}});
  await tracker.bind(grant,{jobId:'bash-job',cwd:'/root'});assert.deepEqual(order,['pending']);
  callback({type:'settled',cause:'producer',job:{...view,status:'completed',detail:'exit code: 0'}});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['pending','pass']);assert.equal(reads,1);
  tracker.dispose();
});
test('already settled event before Bash result is correlated exactly once',async()=>{
  let callback;let completed=0;const job={...view,status:'completed',detail:'exit code: 1'};
  const jobs={get:()=>job,readAt:()=>({chunks:[],lossy:true}),events:{subscribe:(_filter,fn)=>{callback=fn;return()=>{};}}};
  const tracker=createBackgroundChecks(jobs,{pending:async()=>{},complete:async(_grant,outcome)=>{completed++;assert.equal(outcome.exitCode,1);assert.equal(outcome.outputComplete,false);}});
  callback({type:'settled',cause:'producer',job});await tracker.bind(grant,{jobId:job.id,cwd:'/root'});
  callback({type:'settled',cause:'producer',job});await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,1);
});
test('wrong job owner/workspace is never admitted as a check result',async()=>{
  const jobs={get:()=>({...view,owner:'other'}),events:{subscribe:()=>()=>{}}};let pending=0;
  const tracker=createBackgroundChecks(jobs,{pending:async()=>pending++,complete:async()=>{throw new Error('must not complete');}});
  assert.equal(await tracker.bind(grant,{jobId:'bash-job',cwd:'/root'}),false);assert.equal(pending,0);
});
