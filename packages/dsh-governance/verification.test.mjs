import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerification } from './verification.mjs';

function fixture() {
  const records={edits:new Map(),latest:new Map(),runs:new Map()};const handlers=new Map();let guard;let content='source';let pick='use-stored';
  const target=path=>({path});
  const fs={resolve:async path=>target(path),contains:()=>true,listDir:async t=>t.path==='/root'?[{name:'src',target:target('src')}]:[{name:'a.js',target:target('src/a.js')}],lstat:async path=>({type:path==='src'?'directory':'file',version:'opaque'}),readBytes:async()=>Buffer.from(content)};
  const table=name=>({get:key=>records[name].get(key),entries:()=>[...records[name]],put:async(key,value)=>records[name].set(key,value)});
  const ctx={get(name){return{fs,workingDirectory:{ensure:async()=>'/root'},goals:{get:()=>({objective:'Verify the modified source with its declared test suite'})},dshJudge:{decide:async()=>({decision:pick})},tools:{guard:fn=>{guard=fn;return()=>{};}}}[name];},on(name,fn){handlers.set(name,fn);return()=>{};}};
  const verification=createVerification(ctx,{table},{registries:{'/root':{suite:{command:'node --test',files:['src/**/*.js'],coverage:'suite'}}}});
  const agent={session:{id:'s',deriveMessages:()=>[]}};
  const call=(command='node --test',id='call')=>({name:'bash',arguments:{command,workdir:'/root'},agent,callId:id});
  const output=exitCode=>({isError:false,value:{kind:'foreground',cwd:'/root',exitCode,signal:null,aborted:false,timedOut:false,stdout:{text:'test result',truncated:false},stderr:{text:'',truncated:false}}});
  return{verification,records,handlers,call,output,get guard(){return guard;},agent,setContent:value=>{content=value;},setPick:value=>{pick=value;}};
}
test('raw tests require check; exact granted execution records pass and fresh proof can be reused',async()=>{
  const f=fixture();assert.match(f.guard(f.call()),/require check/);
  const first=await f.verification.decide({target:'suite',purpose:'Prove source changes'}, {agent:f.agent});
  assert.equal(first.status,'run');assert.equal(first.command,'node --test');assert.equal(f.guard(f.call()),undefined);
  await f.handlers.get('tools/result')(f.call(),f.output(0));
  const second=await f.verification.decide({target:'suite',purpose:'Prove source changes'}, {agent:f.agent});
  assert.equal(second.status,'use-stored');assert.equal(second.verified,true);assert.equal(second.proof.status,'pass');
});
test('failed and edit-invalidated proof requires a fresh run; wrong workspace never receives a grant',async()=>{
  const f=fixture();await f.verification.decide({target:'suite',purpose:'Prove changes'},{agent:f.agent});
  assert.match(f.guard({...f.call(),arguments:{command:'node --test',workdir:'/other'}}),/another workspace/);
  f.guard(f.call());await f.handlers.get('tools/result')(f.call(),f.output(1));
  assert.equal((await f.verification.decide({target:'suite',purpose:'Prove changes'},{agent:f.agent})).status,'run');
  f.guard(f.call('node --test','call2'));await f.handlers.get('tools/result')(f.call('node --test','call2'),f.output(0));
  await f.handlers.get('tools/result')({name:'edit',agent:f.agent},{isError:false});
  assert.equal((await f.verification.decide({target:'suite',purpose:'Prove changes'},{agent:f.agent})).status,'run');
});
test('skip never provides completion proof; incomplete/background execution is unverified',async()=>{
  const f=fixture();f.setPick('skip');const skip=await f.verification.decide({target:'suite',purpose:'Prove changes'},{agent:f.agent});assert.equal(skip.verified,false);assert.equal(skip.status,'skipped');
  f.setPick('run');await f.verification.decide({target:'suite',purpose:'Prove changes'},{agent:f.agent});f.guard(f.call());
  await f.handlers.get('tools/result')(f.call(),{isError:false,value:{kind:'promoted',jobId:'owned-job'}});
  assert.equal([...f.records.runs.values()][0].status,'unverified');
});
test('simultaneous completed edits monotonically invalidate evidence',async()=>{
  const f=fixture();const observe=f.handlers.get('tools/result');await Promise.all([observe({name:'edit',agent:f.agent},{isError:false}),observe({name:'write',agent:f.agent},{isError:false})]);
  assert.equal(f.verification.editRevision('s'),2);
});
