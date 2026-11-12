// Test discovery tables and shell traversal retain the original DSH behavior.
const RUNNERS=new Set(['pytest','py.test','tox','nox','jest','vitest','mocha','rspec','phpunit','ctest']);
const SUB={playwright:/^test$/,cypress:/^run$/,cargo:/^test$/,go:/^test$/,dotnet:/^test$/,swift:/^test$/,deno:/^test$/};
const TARGET={make:/^(test|check)([-_:]|$)/,mvn:/^test$/,gradle:/^(\S*:)?test$/,gradlew:/^(\S*:)?test$/,xcodebuild:/^test$/};
const PM=new Set(['npm','pnpm','yarn','bun']);
const WRAP={time:[],env:[],builtin:[],command:[],exec:['-a'],nohup:[],timeout:['-s','-k','--signal','--kill-after'],nice:['-n'],stdbuf:['-i','-o','-e']};
const script=path=>(path.split('/').pop()??'').replace(/\.[^.]*$/,'').split(/[^A-Za-z0-9]+/).some(part=>/^(test|tests|pytest|spec|specs)$/i.test(part));
function starts(command){const out=[0];let quote=null,depth=0;for(let i=0;i<command.length;i++){const c=command[i];if(quote==="'"){if(c==="'")quote=null;}else if(c==='\\')i++;else if(quote){if(c===quote)quote=null;}else if(c==="'"||c==='"'||c==='`')quote=c;else if(c==='(')depth++;else if(c===')')depth=Math.max(0,depth-1);else if(c==='&'&&(command[i-1]==='>'||command[i-1]==='<'||command[i+1]==='>'))continue;else if(depth===0&&';|&\n'.includes(c)){if((c==='|'||c==='&')&&command[i+1]===c)i++;out.push(i+1);}}return out;}
function substitutions(command){const bodies=[];let single=false;for(let i=0;i<command.length;i++){const c=command[i];if(single)single=c!=="'";else if(c==='\\')i++;else if(c==="'")single=true;else if(c==='`'){const end=command.indexOf('`',i+1);if(end<0)break;bodies.push(command.slice(i+1,end));i=end;}else if(c==='$'&&command[i+1]==='('){let depth=0,j=i+1;for(;j<command.length;j++){if(command[j]==='(')depth++;else if(command[j]===')'&&--depth===0)break;}bodies.push(command.slice(i+2,j));i=j;}}return bodies;}
function words(s){const out=[];let word=null,quote=null;for(let i=0;i<s.length;i++){const c=s[i];if(quote==="'"){if(c==="'")quote=null;else word+=c;}else if(quote){if(c===quote)quote=null;else word+=c==='\\'&&i+1<s.length?s[++i]:c;}else if(c==="'"||c==='"'){quote=c;word??='';}else if(c==='\\'){i++;if(s[i]!=='\n')word=(word??'')+(s[i]??'');}else if(c===' '||c==='\t'){if(word!==null){out.push(word);word=null;}}else if(';&|\n()'.includes(c))break;else word=(word??'')+c;}if(word!==null)out.push(word);return out;}
export function isTestRun(command,depth=0){
  if(typeof command!=='string')return false;
  if(depth>32)return true; // opaque nested execution must not bypass check
  if(substitutions(command).some(body=>isTestRun(body,depth+1)))return true;
  return starts(command).some(start=>{
    const s=command.slice(start).trimStart();if(s.startsWith('('))return isTestRun(s.slice(1),depth+1);
    const t=words(s);let i=0;const skip=(flags=[])=>{while(t[i]?.startsWith('-'))i+=flags.includes(t[i])?2:1;};
    for(;;){const w=t[i];if(w===undefined)return false;if(w==='command'&&/^-[vV]$/.test(t[i+1]??''))return false;
      if(/^[A-Za-z_]\w*=/.test(w)||w==='{'||w==='!')i++;
      else if(WRAP[w]){i++;skip(WRAP[w]);i+=w==='timeout'?1:0;}
      else if((['uv','poetry','pipenv'].includes(w)&&t[i+1]==='run')||(w==='pnpm'&&t[i+1]==='exec')||(w==='bundle'&&t[i+1]==='exec')){i+=2;skip();}
      else if(w==='npx'||w==='bunx'){i++;skip();}else break;
    }
    const name=t[i].split('/').pop(),args=t.slice(i+1),sub=args.find(a=>!a.startsWith('-'));
    if(name==='eval')return isTestRun(args.join(' '),depth+1);
    if(/^(sh|bash|zsh)$/.test(name)){const c=args.findIndex(a=>/^-[a-z]*c[a-z]*$/.test(a));return c>=0?isTestRun(args[c+1]??'',depth+1):!!sub&&script(sub);}
    if(/^python[\d.]*$/.test(name)){const m=args.indexOf('-m');if(m>=0&&args.slice(0,m).every(a=>a.startsWith('-')))return RUNNERS.has(args[m+1])||args[m+1]==='unittest';return!!sub&&/^test_.*\.py$|_test\.py$/.test(sub.split('/').pop());}
    if(name==='node')return args.includes('--test')||(!!sub&&/\.(test|spec)\.[cm]?[jt]sx?$/.test(sub));
    if(RUNNERS.has(name))return true;
    if(PM.has(name))return!!sub&&(/^test/.test(sub)||(sub==='t'&&name!=='bun')||(sub==='run'&&/^test/.test(args.slice(args.indexOf('run')+1).find(a=>!a.startsWith('-'))??'')));
    if(SUB[name])return!!sub&&SUB[name].test(sub);if(TARGET[name])return args.some(a=>TARGET[name].test(a));
    return t[i].includes('/')&&name!=='test'&&script(name);
  });
}
