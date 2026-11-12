import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { statfs } from 'node:fs/promises';
import { resolvePolicy } from './policy.mjs';
import { trackPolicyReader } from './tracks.mjs';
import { createEventStore } from './event-store.mjs';
import { redactText } from './redaction.mjs';
import { fingerprint, inputGlobs, sameGlobs, chooseCheck } from './verification-policy.mjs';
import { isTestRun } from './test-runs.mjs';
import { createBackgroundChecks } from './background-checks.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const recordSchema={parse(raw){
  if(!raw||raw.v!==1||!['edit','result'].includes(raw.type)||typeof raw.sessionId!=='string')throw new Error('Invalid verification record');
  if(raw.type==='edit'&&(!Number.isSafeInteger(raw.revision)||raw.revision<0))throw new Error('Invalid edit revision');
  if(raw.type==='result'&&(!['pass','fail','unverified'].includes(raw.status)||!Number.isSafeInteger(raw.editRevision)||raw.editRevision<0||typeof raw.root!=='string'||typeof raw.target!=='string'||typeof raw.key!=='string'||typeof raw.id!=='string'||!Number.isSafeInteger(raw.at)||typeof raw.output!=='string'))throw new Error('Invalid check result');
  if(raw.type==='result'&&((raw.status==='pass'&&raw.exitCode!==0)||(raw.status==='fail'&&(!Number.isInteger(raw.exitCode)||raw.exitCode===0))))throw new Error('Check status/exit mismatch');
  return JSON.parse(JSON.stringify(raw));
}};
export const VERIFICATION_DOMAIN_SPEC={name:'dsh_verification',version:1,tables:{edits:{valueSchema:recordSchema},latest:{valueSchema:recordSchema},runs:{valueSchema:recordSchema}}};

/** Owns check decisions and proof metadata. It never executes a test command. */
export function createVerification(ctx,domain,config={}) {
  const pending=new Map(),executing=new Map(),editChains=new Map(),unknownEdits=new Set();
  const tables=domain?{edits:domain.table('edits'),latest:domain.table('latest'),runs:domain.table('runs')}:null;
  const fs=ctx.get('fs');
  const options={maxFiles:config.maxFiles??5000,maxFileBytes:config.maxFileBytes??2097152};
  if(!Number.isSafeInteger(options.maxFiles)||options.maxFiles<1||!Number.isSafeInteger(options.maxFileBytes)||options.maxFileBytes<1)throw new Error('Invalid verification limits');
  const registries=config.registries??{};
  if(!registries||typeof registries!=='object'||Array.isArray(registries))throw new Error('Invalid check registries');
  for(const [root,registry] of Object.entries(registries)){
    if(!isAbsolute(root)||!registry||typeof registry!=='object'||Array.isArray(registry))throw new Error('Check registry requires an absolute workspace root');
    for(const entry of Object.values(registry))if(!entry||typeof entry.command!=='string'||!entry.command.trim()||(entry.files!==undefined&&!inputGlobs(entry)))throw new Error('Invalid registered check command/inputs');
  }
  const editRevision=id=>tables?.edits.get(id)?.revision??0;
  const rootOf=async exec=>{const root=await ctx.get('workingDirectory').ensure(exec.agent,exec.signal);if(!root||root==='/')throw new Error('Check workspace unavailable');return root;};
  const journal=async(agent,decision,reason)=>{const d=ctx.get('storageDomain')?.get?.('dsh_governance_events');if(d)await createEventStore(d).record({v:1,id:randomUUID(),ts:Date.now(),kind:'check',session:agent.session.id,decision,reason,permissionGranted:false});};
  async function decide(args,exec) {
    if(!tables||!fs)throw new Error('Verification store/filesystem unavailable');
    if(!exec.agent||typeof args.target!=='string'||!args.target.trim()||args.target.length>12000||typeof args.purpose!=='string'||!args.purpose.trim())throw new Error('Invalid check request');
    const root=await rootOf(exec),sessionId=exec.agent.session.id;
    const registry=registries[root]??{};
    const entry=Object.hasOwn(registry,args.target)?registry[args.target]:null;
    const command=entry?.command??args.target,target=entry?args.target:`cmd-${hash(command).slice(0,12)}`;
    if(typeof command!=='string'||!command.trim())throw new Error('Invalid registered check');
    const current=await fingerprint(fs,root,command,inputGlobs(entry),{...options,signal:exec.signal});
    const key=hash(`${root}\0${target}`),last=tables.latest.get(key);
    await editChains.get(sessionId);
    const beforeEdit=editRevision(sessionId);
    const goal=ctx.get('goals')?.get?.(exec.agent);
    const human=(exec.agent.session.deriveMessages?.()??[]).filter(m=>m.role==='user'&&m.source?.kind==='user').slice(-3).map(m=>(m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')).join('\n');
    const objective=typeof goal?.objective==='string'?goal.objective:human;
    const objectiveComplete=Boolean(objective?.trim()&&objective.length<=4000&&!unknownEdits.has(sessionId));
    const alternatives=entry?Object.entries(registry).filter(([id,value])=>id!==target&&value.coverage===target&&sameGlobs(inputGlobs(value)??[],inputGlobs(entry)??[])).map(([id,value])=>({id,...value})):[];
    let family='off';try{family=resolvePolicy(sessionId,trackPolicyReader(ctx)).mode??'off';}catch{/* unknown tracks cannot grant a reduction */}
    const judgeService=ctx.get('dshJudge');
    const judged=judgeService?await judgeService.decide({operation:'check',family,state:{acceptance_criterion:objectiveComplete?objective:'',proposed_check:{target,command,purpose:args.purpose,heavy:Boolean(entry?.heavy),coverage:entry?.coverage??'unknown',exact:Boolean(entry?.exact)},last_result:last?{status:last.status,key_matches_current:last.key===current.key,same_session:last.sessionId===sessionId}:null,changed_files:current.paths.slice(0,50),coverage_known:Boolean(entry?.coverage===target&&inputGlobs(entry)),capped:current.capped,override_reason:args.override_reason??'',registered_checks:alternatives.map(({id,command,coverage,heavy})=>({id,command,coverage,heavy:Boolean(heavy)}))}},{signal:exec.signal}):{decision:'UNSURE'};
    await editChains.get(sessionId);
    const after=await fingerprint(fs,root,command,inputGlobs(entry),{...options,signal:exec.signal});
    const choice=chooseCheck({entry,target,current,after,last,sessionId,beforeEdit,afterEdit:editRevision(sessionId),objectiveComplete,judge:judged,alternatives,override:args.override_reason?.trim()});
    await journal(exec.agent,choice.decision,choice.why);
    if(choice.decision==='use-stored')return{status:'use-stored',target,why:choice.why,proof:last,verified:true,permissionGranted:false};
    if(choice.decision==='skip')return{status:'skipped',target,why:choice.why,verified:false,permissionGranted:false};
    const selected=choice.alternative??{id:target,command,files:entry?.files,heavy:entry?.heavy};
    if(selected.heavy){const disk=await statfs(homedir());const free=Number(disk.bavail)*Number(disk.bsize);if(free<30*1024**3&&!args.override_reason?.trim())throw new Error('Heavy check refused below the original 30 GiB disk floor; supply a specific override reason if required');}
    const grant={id:randomUUID(),sessionId,root,target:selected.id,requestedTarget:target,command:selected.command,globs:inputGlobs(selected),beforeEdit:editRevision(sessionId),createdAt:Date.now()};
    pending.set(`${sessionId}\0${grant.command}`,grant);
    return{status:'run',target:selected.id,requestedTarget:target,why:choice.why,command:grant.command,workdir:root,grantId:grant.id,verified:false,permissionGranted:false,
      notice:'Run the exact returned command in this workspace. Native foreground exit status records proof; altered/background/unknown executions do not count. A skipped check never proves completion.'};
  }
  async function capture(grant,outcome){
    const current=await fingerprint(fs,grant.root,grant.command,grant.globs,options);
    await editChains.get(grant.sessionId);
    const status=outcome.settled&&!unknownEdits.has(grant.sessionId)&&editRevision(grant.sessionId)===grant.beforeEdit?(outcome.exitCode===0?'pass':'fail'):'unverified';
    const output=redactText(outcome.output??'').text;
    const record={v:1,type:'result',id:outcome.pending?`${grant.id}-pending`:grant.id,root:grant.root,sessionId:grant.sessionId,target:grant.target,requestedTarget:grant.requestedTarget,key:current.key,status,
      exitCode:outcome.settled?outcome.exitCode:null,at:Date.now(),editRevision:editRevision(grant.sessionId),output:output.slice(-4000),outputComplete:output.length<=4000&&Boolean(outcome.outputComplete),
      nativeKind:outcome.nativeKind??'foreground',...(outcome.jobId?{jobId:outcome.jobId}:{}),...(outcome.pending?{pending:true}:{})};
    await tables.runs.put(record.id,record);await tables.latest.put(hash(`${grant.root}\0${grant.target}`),record);
    await journal({session:{id:grant.sessionId}},outcome.pending?'pending':status,`Check ${grant.target}: ${outcome.pending?'pending background execution':status}; ${outcome.why??'native exit '+outcome.exitCode}`);
  }
  const background=createBackgroundChecks(ctx.get('jobs'),{pending:(grant,jobId)=>capture(grant,{pending:true,settled:false,jobId,nativeKind:'background-job',why:'terminal outcome not available'}),complete:capture});
  const disposeGuard=ctx.get('tools').guard(exec=>{
    if(exec.name!=='bash'||typeof exec.arguments?.command!=='string')return;
    const key=`${exec.agent?.session?.id}\0${exec.arguments.command}`,grant=pending.get(key);
    if(grant){if(resolve(grant.root,exec.arguments.workdir??'.')!==resolve(grant.root))return 'Check grant belongs to another workspace; use its returned workdir unchanged.';pending.delete(key);executing.set(exec.callId??key,grant);return;}
    if(isTestRun(exec.arguments.command))return 'Test runs require check(target=<command>, purpose=<criterion>). A # OVERRIDE comment does not bypass verification.';
  });
  const disposeResult=ctx.on('tools/result',async(exec,result)=>{
    const sessionId=exec.agent?.session?.id;if(!sessionId||!tables)return;
    if(['edit','write','apply_patch'].includes(exec.name)&&result.isError===false){
      const action=(editChains.get(sessionId)??Promise.resolve()).catch(()=>{}).then(()=>tables.edits.put(sessionId,{v:1,type:'edit',sessionId,revision:editRevision(sessionId)+1}));
      editChains.set(sessionId,action);try{await action;}catch(error){unknownEdits.add(sessionId);throw error;}finally{if(editChains.get(sessionId)===action)editChains.delete(sessionId);}return;
    }
    if(exec.name!=='bash')return;
    const key=exec.callId??`${sessionId}\0${exec.arguments?.command}`,grant=executing.get(key);if(!grant)return;executing.delete(key);
    const value=result.value;
    if(result.isError===false&&['background','promoted'].includes(value?.kind)&&await background.bind(grant,value))return;
    const settled=result.isError===false&&value?.kind==='foreground'&&Number.isInteger(value.exitCode)&&value.signal===null&&!value.aborted&&!value.timedOut&&value.cwd===grant.root;
    await capture(grant,{settled,exitCode:settled?value.exitCode:null,why:settled?'native exit '+value.exitCode:'execution outcome not established',output:`${value?.stdout?.text??''}\n${value?.stderr?.text??''}`,outputComplete:!value?.stdout?.truncated&&!value?.stderr?.truncated,nativeKind:'foreground'});
  });
  return{decide,editRevision,dispose(){pending.clear();executing.clear();background.dispose();disposeGuard?.();disposeResult?.();}};
}
