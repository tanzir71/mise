import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';

const rules=[
  ['supabase-api-key','credential',/sb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}/],
  ['supabase-access-token','credential',/sbp_[A-Za-z0-9]{20,}/],
  ['jwt-token','credential',/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}/],
  ['database-password-url','credential',/postgres(?:ql)?:\/\/[^\s/'"@:]+:[^\s/'"@]+@/],
  ['private-key','credential',/-----BEGIN (?:(?:RSA|EC|OPENSSH) )?PRIVATE KEY-----/],
  ['github-token','credential',/gh[pousr]_[A-Za-z0-9]{20,}/],
  ['github-fine-grained-token','credential',/github_pat_[A-Za-z0-9_]{40,}/],
  ['supabase-deployment-url','deployment',/https?:\/\/(?:[a-z]{20}\.supabase\.(?:co|in|net)\b|supabase\.com\/dashboard\/project\/[a-z]{20}\b)/],
  ['supabase-deployment-reference','deployment',/"(?:project|project_ref|organization|organization_id)"\s*:\s*"[a-z]{20}"/],
];
function location(path,known){let safe=path;for(const [, ,pattern] of rules)safe=safe.replace(new RegExp(pattern.source,'g'),'[redacted]');for(const {value} of known)if(value.length>=16)safe=safe.replaceAll(value,'[redacted]');return safe;}
// Windows PowerShell commonly writes UTF-16. Inspect both byte orders, including
// files without a BOM, so null bytes cannot hide an otherwise recognizable key.
function decodedTexts(data){
  const raw=data.toString('latin1'),texts=[raw];
  const bom=data.length>=2&&((data[0]===255&&data[1]===254)||(data[0]===254&&data[1]===255));
  if(bom||/(?:[\x09\x0a\x0d\x20-\x7e]\x00){8}|(?:\x00[\x09\x0a\x0d\x20-\x7e]){8}/.test(raw)){
    texts.push(data.toString('utf16le'));
    const swapped=Buffer.from(data.subarray(0,data.length-data.length%2));swapped.swap16();texts.push(swapped.toString('utf16le'));
  }
  return texts;
}
/** Findings contain locations and rule names only, never matched values. */
export function inspectSecretBytes(bytes,path,known=[],depth=0){
  const data=Buffer.from(bytes),texts=decodedTexts(data),findings=[],safePath=location(path,known);
  for(const [rule,kind,pattern] of rules)if(texts.some(text=>pattern.test(text))||pattern.test(path))findings.push({path:safePath,rule,kind});
  for(const item of known)if(item.value.length>=16&&(data.includes(Buffer.from(item.value))||texts.some(text=>text.includes(item.value))||path.includes(item.value)))findings.push({path:safePath,rule:item.rule,kind:item.kind});
  if(data[0]===80&&data[1]===75&&data[2]===3&&data[3]===4){
    if(depth>=2)return [...findings,{path:safePath,rule:'nested-archive-limit',kind:'coverage'}];
    let total=0;
    try{const entries=unzipSync(data,{filter:file=>{total+=file.originalSize;if(file.originalSize>16*1024*1024||total>100*1024*1024){findings.push({path:location(path+'!'+file.name,known),rule:'archive-size-limit',kind:'coverage'});return false;}return true;}});
      for(const [name,body] of Object.entries(entries))findings.push(...inspectSecretBytes(body,path+'!'+name,known,depth+1));
    }catch{findings.push({path:safePath,rule:'unreadable-archive',kind:'coverage'});}
  }
  return findings;
}
function git(args,input,buffer=false){const r=spawnSync('git',args,{input,encoding:buffer?undefined:'utf8',maxBuffer:128*1024*1024,windowsHide:true});if(r.status!==0)throw new Error('Git audit command failed: '+args[0]);return r.stdout;}
function localConfig(name){const r=spawnSync('git',['config','--local','--get-all',name],{encoding:'utf8',maxBuffer:64*1024,windowsHide:true});if(r.status===1)return [];if(r.status!==0)throw new Error('Private audit configuration cannot be read.');return r.stdout.trim().split(/\r?\n/).filter(Boolean);}
function knownValues(directory){
  if(!directory)return [];
  const result=[],add=(value,rule,kind='credential')=>{if(typeof value==='string'&&value.length>=16)result.push({value,rule,kind});};
  const raw=readFileSync(join(directory,'api-keys.json'),'utf8');let document;try{document=JSON.parse(raw.slice(raw.indexOf('{')));}catch{throw new Error('Private key document cannot be parsed.');}
  function visit(v){if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){if(typeof v.api_key==='string')add(v.api_key,'known-supabase-key');else Object.values(v).forEach(visit);}}
  visit(document);const project=raw.match(/Target: project [^\r\n]*\(([a-z]{20})\)/)?.[1];if(project)add(project,'known-deployment-reference','deployment');
  for(const line of readFileSync(join(directory,'edge.env'),'utf8').split(/\r?\n/)){const match=line.match(/^(MISE_(?:SERVICE_API_KEY|PUBLISHABLE_API_KEY|STAFF_PIN_PEPPER_V\d+|SYNC_CURSOR_KEY_V\d+))=(.+)$/);if(match)add(match[2].replace(/^['"]|['"]$/g,''),'known-edge-secret');}
  return result;
}
function walk(directory){const result=[];for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())result.push(...walk(path));else if(entry.isFile())result.push(path);}return result;}
export function auditRepository({history=false,artifacts=false,knownDirectory}={}){
  const directories=knownDirectory===undefined?localConfig('mise.secretScanDirectory'):[knownDirectory];if(directories.length>1)throw new Error('Choose one private audit directory.');
  const known=knownValues(directories[0]),references=localConfig('mise.privateDeploymentRef');
  for(const value of references){if(!/^[a-z]{20}$/.test(value))throw new Error('Invalid private deployment audit reference.');if(!known.some(item=>item.value===value))known.push({value,rule:'known-deployment-reference',kind:'deployment'});}
  const findings=[];let objects=0,files=0,archiveFiles=0;
  const inspect=(body,path)=>{objects++;if(Buffer.from(body).subarray(0,4).equals(Buffer.from([80,75,3,4])))archiveFiles++;findings.push(...inspectSecretBytes(body,path,known));};
  const tracked=git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  for(const path of new Set(tracked)){if(!lstatSync(path,{throwIfNoEntry:false})?.isFile())continue;files++;inspect(readFileSync(path),'worktree:'+path);}
  // Inspect index blobs too: a clean working copy can hide an earlier staged secret.
  const index=git(['ls-files','--stage','-z']).split('\0').filter(Boolean).map(line=>{const match=line.match(/^\d+ ([a-f0-9]{40}) \d\t([\s\S]+)$/);if(!match)throw new Error('Git index audit incomplete.');return {id:match[1],path:match[2]};});
  function inspectBlobs(blobs,label){for(let at=0;at<blobs.length;at+=8){const group=blobs.slice(at,at+8),output=git(['cat-file','--batch'],group.map(b=>b.id).join('\n')+'\n',true);let offset=0;
    for(const blob of group){const end=output.indexOf(10,offset),header=output.subarray(offset,end).toString('ascii').split(' '),size=Number(header[2]);if(header[0]!==blob.id||header[1]!== (blob.type??'blob')||!Number.isSafeInteger(size)||end+1+size>output.length)throw new Error('Git object audit incomplete.');const name=blob.type&&blob.type!=='blob'?blob.type+(blob.path?':'+blob.path:''):blob.path;inspect(output.subarray(end+1,end+1+size),label+blob.id.slice(0,12)+':'+name);offset=end+size+2;}
  }}
  inspectBlobs(index,'index:');
  if(artifacts&&lstatSync('site',{throwIfNoEntry:false})?.isDirectory())for(const path of walk('site'))inspect(readFileSync(path),'artifact:'+relative('.',path).replaceAll('\\','/'));
  if(history){
    const entries=git(['rev-list','--objects','--all']).trim().split('\n').filter(Boolean).map(line=>({id:line.slice(0,40),path:line.slice(41)}));
    const metadata=git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],entries.map(e=>e.id).join('\n')+'\n').trim().split('\n');
    const blobs=metadata.flatMap((line,i)=>{const type=line.split(' ')[1];return ['blob','commit','tag'].includes(type)?[{...entries[i],type}]:[];});
    inspectBlobs(blobs,'history:');
  }
  const credentials=findings.filter(f=>f.kind==='credential'),coverage=findings.filter(f=>f.kind==='coverage'),currentDeployment=findings.filter(f=>f.kind==='deployment'&&!f.path.startsWith('history:'));
  return {ok:credentials.length===0&&coverage.length===0&&currentDeployment.length===0,files,objects,archiveFiles,history,artifacts,knownValuesChecked:known.length,credentialFindings:credentials.length,currentDeploymentFindings:currentDeployment.length,historicalDeploymentFindings:findings.filter(f=>f.kind==='deployment'&&f.path.startsWith('history:')).length,coverageFindings:coverage.length,findings};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2),knownAt=args.indexOf('--known-directory'),report=auditRepository({history:args.includes('--history'),artifacts:args.includes('--artifacts'),knownDirectory:knownAt<0?undefined:args[knownAt+1]});console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;}
  catch{console.error(JSON.stringify({ok:false,error:'Secret audit could not complete. Check Git access and private input files.'}));process.exitCode=1;}
}
