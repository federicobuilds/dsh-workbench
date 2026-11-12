import { createHash } from 'node:crypto';
export const inputGlobs = entry => Array.isArray(entry?.files) && entry.files.length > 0 && entry.files.every(value => typeof value === 'string' && value && !value.startsWith('/') && !value.split('/').includes('..')) ? entry.files : null;
export const sameGlobs = (a,b) => a.every(value=>b.includes(value)) && b.every(value=>a.includes(value));
/** Original DSH glob subset: ** spans directories; * and ? do not. */
export function globRe(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/|\*\*|\*|\?/g, token => ({'**/':'(.*/)?','**':'.*','*':'[^/]*','?':'[^/]'}[token]));
  return new RegExp(`^${body}$`);
}
const digest = value => createHash('sha256').update(value).digest('hex');
const SKIP = new Set(['.git','node_modules','.venv','__pycache__']);

/** Fingerprint through the mounted native filesystem provider. No direct Node
 * reads or invented file versions. Incomplete observation never permits reuse. */
export async function fingerprint(fs, root, command, globs, { signal, maxFiles=5000, maxFileBytes=2*1024*1024 } = {}) {
  const files = [], blind = []; const patterns = globs?.map(globRe);
  const rootTarget = await fs.resolve(root,{signal});
  const pending = [{ rel:'', target:rootTarget }]; let capped=false;
  while(pending.length) {
    const dir=pending.pop(); let entries;
    try { entries=await fs.listDir(dir.target,signal); } catch { blind.push(dir.rel||'.'); continue; }
    for(const entry of entries) {
      const rel=dir.rel?`${dir.rel}/${entry.name}`:entry.name;
      let pathInfo;
      try { pathInfo=await fs.lstat(rel,{cwd:root},signal); } catch { blind.push(rel); continue; }
      if (!fs.contains(rootTarget,entry.target)) { blind.push(rel); continue; }
      if (pathInfo?.type==='symlink' || !pathInfo || pathInfo.type==='other') { blind.push(rel); continue; }
      if (pathInfo.type==='directory') { if(!SKIP.has(entry.name)) pending.push({rel,target:entry.target}); continue; }
      if (files.length>=maxFiles) { capped=true; break; }
      files.push({rel,target:entry.target,version:pathInfo.version});
    }
    if(capped)break;
  }
  files.sort((a,b)=>a.rel.localeCompare(b.rel));
  const chosen=patterns?files.filter(file=>patterns.some(pattern=>pattern.test(file.rel))):files;
  const values=[];let unreadable=0;
  for(const file of chosen) {
    if(!patterns) { values.push(`${file.rel}\0${file.version}`); continue; }
    try { const bytes=await fs.readBytes(file.target,signal,maxFileBytes);values.push(`${file.rel}\0${digest(bytes)}`); }
    catch { unreadable++; values.push(`${file.rel}\0unreadable`); }
  }
  return { key:digest(`${command}\0${values.join('\n')}`), paths:chosen.map(file=>file.rel), capped, unreadable, blind };
}
export function inputGap(value) { return value.capped?'Input scan capped':value.blind.length?'Input observation incomplete':!value.paths.length?'No declared input matched':value.unreadable?'Declared input unreadable':null; }

/** A judge recommendation is constrained by declared coverage, current inputs,
 * durable edit history and the latest same-session passing result. */
export function chooseCheck({ entry, target, current, after, last, sessionId, beforeEdit, afterEdit, objectiveComplete, judge, alternatives=[], override }) {
  if(entry?.exact || override || current.capped || !objectiveComplete) return {decision:'run',why:entry?.exact?'Exact checks run fresh':override?'Operator forced a fresh run':current.capped?'Input scan capped':'Objective incomplete'};
  if(judge?.decision==='run')return{decision:'run',why:'Judge requires a fresh run'};
  if(!['use-stored','skip','alternative'].includes(judge?.decision))return{decision:'run',why:'Judge did not establish a reduction'};
  const globs=inputGlobs(entry);
  if(!entry || entry.coverage!==target || !globs || inputGap(current) || inputGap(after))return{decision:'run',why:'Declared coverage is unknown or incomplete'};
  if(current.key!==after.key || beforeEdit!==afterEdit)return{decision:'run',why:'Inputs/edit history changed during judging'};
  if(judge.decision==='use-stored' && (!last || last.status!=='pass' || last.key!==current.key || last.sessionId!==sessionId || last.editRevision!==afterEdit))return{decision:'run',why:'No fresh same-session stored pass'};
  if(judge.decision==='alternative') {
    const alternative=alternatives.find(value=>value.id===judge.alternative && value.coverage===target && sameGlobs(inputGlobs(value)??[],globs));
    if(!alternative)return{decision:'run',why:'No registered equivalent alternative'};
    return{decision:'alternative',alternative,why:'Registered equivalent check selected'};
  }
  return{decision:judge.decision,why:judge.decision==='skip'?'Judge selected skip; no proof credit':'Stored proof is fresh'};
}
