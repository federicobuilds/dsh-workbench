import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkerGuard } from './worker-guard.mjs';
import { createGovernanceFacade } from './facade-core.mjs';
import { publishRoleModelOverrides } from './bindings.mjs';
import { normalizeConfig, resolvePolicy } from './policy.mjs';
import { trackPolicyReader } from './tracks.mjs';
const ROUTE = { provider:'openrouter', model:'xiaomi/mimo-v2.6-flash', effort:null };
const AUX = { provider:'openrouter', model:'deepseek/deepseek-v4.1-flash-1017', effort:null };
async function fixture({ legacy = false } = {}) {
  const workers = new Map(), tracks = new Map(), events = new Map(), handlers = new Map(), modes = new Map(), toolGuards = [];
  const table = records => ({ get:id=>records.get(id), entries:()=>[...records], put:async(id,value)=>records.set(id,value), update:async(id,fn)=>records.set(id,fn(records.get(id))) });
  const workerDomain = { table:()=>table(workers) }, trackStore = { table:()=>table(tracks) }, eventStore = { table:()=>table(events) };
  const parent = { id:'parent', header:{ id:'parent' } };
  const child = { id:'child', header:{ id:'child', origin:'subagent', parentSession:'parent', agentPreset:legacy?'standard':'dsh-worker-executor' } };
  child.append = (type, data) => { if (type === 'sandbox/mode') modes.set(child.id, data.mode); };
  const sessions = new Map([['parent',parent],['child',child]]);
  const services = { sessions:{get:id=>sessions.get(id)}, agentPresets:{presetForSession:s=>s.id==='parent'?(legacy?'standard':'dsh-coordinator-simple'):s.header.agentPreset},
    storageDomain:{get:name=>name==='dsh_worker_tracks'?trackStore:name==='dsh_governance_events'?eventStore:workerDomain},
    tools:{guard:fn=>{toolGuards.push(fn);return()=>{};}}, sandboxPolicy:{resolve:({session})=>({mode:modes.get(session.id)??'workspace-write'})} };
  const ctx = { get:name=>services[name], on:(name,fn)=>{handlers.set(name,fn);return()=>{};} };
  const guard=createWorkerGuard(ctx,workerDomain,{compactionRoute:AUX});
  guard.setSnapshot(normalizeConfig({revision:'cfg-1',providers:{openrouter:{baseURL:null}},seats:{'executor-s-cheap':{enabled:true,route:ROUTE}}}));
  const bind = async(options={})=>guard.reserve({childId:'child',parentId:'parent',unit:'U-1',seat:'executor-s-cheap',family:'simple',preset:'dsh-worker-executor',route:ROUTE,policy:resolvePolicy('parent',trackPolicyReader(ctx)),configRevision:'cfg-1',...options});
  return { guard, bind, ctx, handlers, tracks, workers, events, sessions, child, modes, toolGuards };
}

test('read-only admission pins the native sandbox and denies writes or later escalation', async () => {
  const f = await fixture();
  await f.bind({ readOnly: true });
  const agent = { session: f.child };
  f.handlers.get('agent/created')({ agent });
  assert.equal(f.modes.get('child'), 'read-only');
  assert.equal(f.workers.get('child').readOnly, true);
  const guard = f.toolGuards[0];
  assert.match(guard({ agent, name: 'write', arguments: { path: '/workspace/report.md' } }), /not authorized/);
  assert.match(guard({ agent, name: 'bash', arguments: { sandboxMode: 'danger-full-access', command: 'touch report.md' } }), /escalation/);
  assert.equal(guard({ agent, name: 'read', arguments: { path: '/workspace/report.md' } }), undefined);
  assert.equal(guard({ agent, name: 'bash', arguments: { command: 'pwd' } }), undefined);
  f.modes.set('child', 'workspace-write');
  assert.match(guard({ agent, name: 'bash', arguments: { command: 'pwd' } }), /sandbox is not ready/);
  f.guard.dispose();
});
test('pending native identity is bound before first step; active binding survives a new guard instance', async()=>{
  const f=await fixture();await f.bind();
  assert.equal(f.guard.check('child',ROUTE).allowed,true);
  let next=0; const result=await f.handlers.get('agent/pre-step')({agent:{session:f.child},modelSelection:{provider:ROUTE.provider,model:ROUTE.model}},()=>{next++;return{kind:'enter'};});
  assert.equal(result.kind,'enter');assert.equal(next,1);
  await f.guard.settle('child','active');
  const other=createWorkerGuard(f.ctx,{table:()=>({get:id=>f.workers.get(id)})},{compactionRoute:AUX});
  other.setSnapshot(normalizeConfig({revision:'cfg-1',providers:{openrouter:{baseURL:null}},seats:{'executor-s-cheap':{enabled:true,route:ROUTE}}}));
  assert.equal(other.check('child',ROUTE).allowed,true);
});
test('Off blocks pre-step and the actual stream without calling provider dispatch', async()=>{
  const f=await fixture();await f.bind();await f.guard.settle('child','active');
  f.tracks.set('parent',{v:1,sessionId:'parent',mode:'off',revision:1});
  let next=0;const result=await f.handlers.get('agent/pre-step')({agent:{session:f.child},modelSelection:ROUTE},()=>{next++;return{kind:'enter'};});
  assert.equal(result.kind,'reject');assert.equal(next,0);
  const chunks=[];for await(const chunk of f.handlers.get('llm/stream')({sessionId:'child',...ROUTE},()=>{next++;return(async function*(){yield{type:'finish'};})();}))chunks.push(chunk);
  assert.equal(next,0);assert.equal(chunks[0].reason.kind,'error');assert.match(chunks[0].reason.failure.message,/worker-track-off/);
  assert.ok([...f.events.values()].some(e=>e.reasonCode==='worker-track-off'));
  assert.ok([...f.events.values()].some(e=>e.session==='parent' && e.childId==='child'), 'creator can see why its worker was stopped');
});
test('Off denies governed and ordinary children while an unselected ordinary child remains admitted otherwise', async()=>{
  const governed=await fixture();await governed.bind();await governed.guard.settle('child','active');
  governed.tracks.set('parent',{v:1,sessionId:'parent',mode:'off',revision:1});
  assert.equal(governed.guard.check('child',ROUTE).denied,'worker-track-off');
  const ordinary=await fixture({legacy:true});
  assert.equal(ordinary.guard.check('child',ROUTE).allowed,true);
  ordinary.tracks.set('parent',{v:1,sessionId:'parent',mode:'off',revision:1});
  assert.equal(ordinary.guard.check('child',ROUTE).denied,'worker-track-off');
});
test('facade publication updates native worker admission and disposal fails closed', async()=>{
  const roster=JSON.parse(await readFile(new URL('./test-fixtures/role-roster.synthetic.json',import.meta.url),'utf8'));
  const workers=new Map(),tracks=new Map(),reviews=new Map();
  const table=records=>({get:id=>records.get(id),entries:()=>[...records],put:async(id,value)=>records.set(id,value),update:async(id,fn)=>records.set(id,fn(records.get(id)))});
  const workerDomain={table:()=>table(workers)},trackStore={table:()=>table(tracks)},reviewDomain={table:()=>table(reviews),close:async()=>{}};
  const sessions=new Map([['parent',{id:'parent',header:{id:'parent'}}],...['child','fresh-child'].map(id=>[id,{id,header:{id,origin:'subagent',parentSession:'parent',agentPreset:'dsh-worker-executor'}}])]);
  const services={sessions:{get:id=>sessions.get(id)},agentPresets:{presetForSession:session=>session.id==='parent'?'dsh-coordinator-simple':session.header.agentPreset},
    storageDomain:{open:async()=>reviewDomain,get:name=>name==='dsh_worker_tracks'?trackStore:undefined},tools:{register:()=>()=>{},guard:()=>()=>{}}};
  const ctx={get:name=>services[name],on:()=>()=>{}};
  const guard=createWorkerGuard(ctx,workerDomain);
  let currentSnapshot;
  const facadeGuard={...guard,setSnapshotProvider(provider){currentSnapshot=provider;guard.setSnapshotProvider(provider);}};
  const disposeFacade=await createGovernanceFacade({roster,workerGuard:facadeGuard}).apply(ctx);
  const base=currentSnapshot();
  let disposePublication=publishRoleModelOverrides(ctx,{simpleExecutorCheapModel:'openrouter/synthetic-one'},{},'fresh-1');
  try {
    const changed=currentSnapshot();
    assert.notEqual(changed.revision,base.revision);
    assert.equal(changed.revision,'fresh-1');
    assert.deepEqual(changed.seats['executor-s-cheap'].route,{provider:'openrouter',model:'synthetic-one',effort:null});
    const policy=resolvePolicy('parent',trackPolicyReader(ctx));
    await guard.reserve({childId:'child',parentId:'parent',unit:'U-1',seat:'executor-s-cheap',family:'simple',preset:'dsh-worker-executor',route:changed.seats['executor-s-cheap'].route,policy,configRevision:changed.revision});
    await guard.settle('child','active');
    assert.equal(guard.check('child',changed.seats['executor-s-cheap'].route).allowed,true);
    const oldDispose=disposePublication;
    disposePublication=publishRoleModelOverrides(ctx,{simpleExecutorCheapModel:'openrouter/synthetic-two'},{},'fresh-2');
    oldDispose();
    assert.equal(guard.check('child',changed.seats['executor-s-cheap'].route).denied,'worker-config-or-track-changed');
    const fresh=currentSnapshot();
    assert.equal(fresh.revision,'fresh-2');
    assert.equal(fresh.seats['executor-s-cheap'].route.model,'synthetic-two');
    await guard.reserve({childId:'fresh-child',parentId:'parent',unit:'U-2',seat:'executor-s-cheap',family:'simple',preset:'dsh-worker-executor',route:fresh.seats['executor-s-cheap'].route,policy,configRevision:fresh.revision});
    await guard.settle('fresh-child','active');
    assert.equal(guard.check('fresh-child',fresh.seats['executor-s-cheap'].route).allowed,true);
    await disposeFacade();
    assert.equal(currentSnapshot,null);
    assert.equal(guard.check('fresh-child',fresh.seats['executor-s-cheap'].route).denied,'worker-admission-missing');
  } finally { disposePublication(); guard.dispose(); }
});
test('actual route, creator, preset and track revisions are checked independently', async()=>{
  const f=await fixture();await f.bind();await f.guard.settle('child','active');
  assert.equal(f.guard.check('child',{...ROUTE,model:'different'}).denied,'worker-actual-route-mismatch');
  f.child.header.parentSession='other';assert.equal(f.guard.check('child',ROUTE).denied,'worker-ancestry-unavailable');f.child.header.parentSession='parent';
  f.tracks.set('parent',{v:1,sessionId:'parent',mode:'simple',revision:1});assert.equal(f.guard.check('child',ROUTE).denied,'worker-policy-revision-changed');
});
test('changed or unavailable routing snapshots fail closed before a worker request', async()=>{
  const f=await fixture();await f.bind();await f.guard.settle('child','active');
  let revision='cfg-1';
  f.guard.setSnapshotProvider(()=>normalizeConfig({revision,providers:{openrouter:{baseURL:null}},seats:{'executor-s-cheap':{enabled:true,route:ROUTE}}}));
  assert.equal(f.guard.check('child',ROUTE).allowed,true);
  revision='cfg-2';
  assert.equal(f.guard.check('child',ROUTE).denied,'worker-config-or-track-changed');
  f.guard.setSnapshotProvider(()=>{throw new Error('unavailable');});
  assert.equal(f.guard.check('child',ROUTE).denied,'worker-config-unavailable');
});
test('compaction uses its explicit auxiliary assignment; unknown purpose is refused', async()=>{
  const f=await fixture();await f.bind();await f.guard.settle('child','active');
  assert.equal(f.guard.check('child',AUX,'compaction').allowed,true);
  assert.equal(f.guard.check('child',ROUTE,'compaction').denied,'worker-compaction-route-mismatch');
  assert.equal(f.guard.check('child',ROUTE,'unknown').denied,'worker-auxiliary-purpose-unapproved');
});
test('unselected ordinary DSH children retain legacy behavior, but DSH pattern requires an admission',async()=>{
  const legacy=await fixture({legacy:true});assert.equal(legacy.guard.check('child',ROUTE).allowed,true);
  const f=await fixture();assert.equal(f.guard.check('child',ROUTE).denied,'worker-admission-missing');
  assert.equal(f.guard.check(undefined,ROUTE).allowed,true);
  f.child.header.origin = 'user';
  assert.equal(f.guard.check('child',ROUTE).denied,'worker-origin-mismatch');
});
