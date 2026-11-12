import test from 'node:test';
import assert from 'node:assert/strict';
import { globRe, inputGlobs, fingerprint, chooseCheck } from './verification-policy.mjs';
import { isTestRun } from './test-runs.mjs';
const entry={command:'node --test',files:['src/**/*.js'],coverage:'suite'};
const key={key:'key',paths:['src/a.js'],capped:false,unreadable:0,blind:[]};
const context={entry,target:'suite',current:key,after:key,last:{status:'pass',key:'key',sessionId:'s',editRevision:2},sessionId:'s',beforeEdit:2,afterEdit:2,objectiveComplete:true};
test('original test recognition includes wrappers/substitutions but ignores quoted examples',()=>{
  for(const cmd of ['pytest -q','uv run python -m unittest','node --test','pnpm run test:unit','echo $(pytest -q)','bash -c "pytest -q"','env X=1 timeout 10 pytest','cargo test','make check-unit'])assert.equal(isTestRun(cmd),true,cmd);
  for(const cmd of ['echo "pytest -q"','command -v pytest','ls tests','test -f file'])assert.equal(isTestRun(cmd),false,cmd);
});
test('declared globs are contained and retain original star/directory semantics',()=>{
  assert.equal(globRe('src/**/*.js').test('src/a.js'),true);assert.equal(globRe('src/**/*.js').test('src/x/a.js'),true);
  assert.equal(globRe('src/*.js').test('src/x/a.js'),false);assert.equal(inputGlobs({files:['../private']}),null);
});
test('only current same-session proof can be reused; no skip or alternative fabricates pass',()=>{
  assert.equal(chooseCheck({...context,judge:{decision:'use-stored'}}).decision,'use-stored');
  assert.equal(chooseCheck({...context,afterEdit:3,judge:{decision:'use-stored'}}).decision,'run');
  assert.equal(chooseCheck({...context,last:{...context.last,status:'fail'},judge:{decision:'use-stored'}}).decision,'run');
  assert.equal(chooseCheck({...context,last:{...context.last,sessionId:'other'},judge:{decision:'use-stored'}}).decision,'run');
  assert.equal(chooseCheck({...context,judge:{decision:'skip'}}).decision,'skip');
  assert.equal(chooseCheck({...context,judge:{decision:'alternative',alternative:'unregistered'}}).decision,'run');
});
test('unknown coverage, exact checks, incomplete objective and unavailable judge force fresh work',()=>{
  for(const extra of [{entry:null},{entry:{...entry,exact:true}},{objectiveComplete:false},{judge:{decision:'UNSURE'}}])assert.equal(chooseCheck({...context,judge:{decision:'skip'},...extra}).decision,'run');
});
test('provider fingerprints hash declared bytes and reject incomplete observation for reduction',async()=>{
  const contents=new Map([['src/a.js','one'],['src/b.js','two']]);
  const target=path=>({path});
  const fs={resolve:async path=>target(path),contains:()=>true,listDir:async t=>t.path==='/root'?[{name:'src',target:target('src')}]:[...contents].map(([path])=>({name:path.split('/')[1],target:target(path)})),lstat:async path=>({type:path==='src'?'directory':'file',version:'opaque-'+path}),readBytes:async t=>Buffer.from(contents.get(t.path))};
  const before=await fingerprint(fs,'/root','test',entry.files);contents.set('src/a.js','changed');const after=await fingerprint(fs,'/root','test',entry.files);
  assert.notEqual(before.key,after.key);assert.equal(before.blind.length,0);
  const limited=await fingerprint(fs,'/root','test',entry.files,{maxFiles:1});assert.equal(limited.capped,true);
});
