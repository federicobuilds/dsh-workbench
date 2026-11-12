/** Non-consuming owned-job observation for native Bash check grants. */
export function classifyJob(grant, job, cause) {
  if(job.owner!==grant.sessionId||job.kind!=='bash'||job.label!==grant.command)return{settled:false,exitCode:null,why:'Job identity/owner does not match the check'};
  if(['running','stopping'].includes(job.status))return null;
  const match=/^exit code: (-?\d+)$/.exec(job.detail??'');
  if(job.status!=='completed'||cause!=='producer'||!match)return{settled:false,exitCode:null,why:'Job did not report a complete native process outcome'};
  const exitCode=Number(match[1]);
  if(!Number.isSafeInteger(exitCode))return{settled:false,exitCode:null,why:'Native exit status invalid'};
  return{settled:true,exitCode,why:`native job exit ${exitCode}`};
}

/** Registry events are observed without wait()/read(): model cursor and normal
 * completion notices remain untouched. A late binding reuses the cached commit. */
export function createBackgroundChecks(jobs,{pending,complete}) {
  const tracked=new Map(),settled=new Map();let active=true;
  async function finish(id,event) {
    const record=tracked.get(id);if(!record||record.phase!=='ready'||!active)return;
    const outcome=classifyJob(record.grant,event.job,event.cause);if(outcome===null)return;
    record.phase='finishing';
    let output='',outputComplete=false;
    try{const read=jobs.readAt(id,0,record.grant.sessionId);output=read.chunks.filter(chunk=>chunk.channel==='stdout'||chunk.channel==='stderr').map(chunk=>chunk.text).join('');outputComplete=!read.lossy;}catch{/* outcome still establishes exit, output stays unavailable */}
    try{await complete(record.grant,{...outcome,output,outputComplete,nativeKind:'background-job',jobId:id});}
    finally{tracked.delete(id);settled.delete(id);}
  }
  const unsubscribe=jobs?.events?.subscribe({owners:'scope'},event=>{
    if(event.type!=='settled')return;
    settled.set(event.job.id,event);
    if(settled.size>256)settled.delete(settled.keys().next().value);
    void finish(event.job.id,event).catch(()=>{});
  });
  return{
    async bind(grant,value){
      if(!jobs||!active||value.cwd!==grant.root||typeof value.jobId!=='string')return false;
      let job;try{job=jobs.get(value.jobId,grant.sessionId);}catch{return false;}
      if(job.owner!==grant.sessionId||job.kind!=='bash'||job.label!==grant.command)return false;
      const id=job.id,record={grant,phase:'binding'};tracked.set(id,record);
      try{await pending(grant,id);}catch(error){tracked.delete(id);throw error;}
      if(!active||tracked.get(id)!==record)return false;
      record.phase='ready';
      const terminal=settled.get(id);
      if(terminal)await finish(id,terminal);
      else if(!['running','stopping'].includes(job.status))await finish(id,{job,cause:undefined});
      return true;
    },
    dispose(){active=false;tracked.clear();settled.clear();unsubscribe?.();},
  };
}
