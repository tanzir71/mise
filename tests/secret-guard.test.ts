import {afterEach,expect,it} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,copyFileSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
// @ts-expect-error The repository guard is a standalone Node script.
import {inspectSecretBytes} from '../scripts/check-secrets.mjs';
const key='sb_secret_'+'x'.repeat(32);
// Git fixtures run synchronously. Let the worker deliver progress between cases
// so a complete history scan cannot starve the runner's normal RPC deadline.
afterEach(()=>new Promise<void>(resolve=>setImmediate(resolve)));
function utf16(text:string,bigEndian:boolean,bom:boolean){const body=Buffer.from(text,'utf16le');if(bigEndian)body.swap16();return bom?Buffer.concat([Buffer.from(bigEndian?[254,255]:[255,254]),body]):body;}
it.each([[false,false],[false,true],[true,false],[true,true]])('detects UTF-16 credentials (big endian: %s, BOM: %s) without exposing their values',(bigEndian,bom)=>{
  const pepper='f17c'.repeat(16),bytes=utf16('KEY='+key+'\nPEPPER='+pepper,bigEndian,bom);
  const result=inspectSecretBytes(bytes,'windows.txt',[{value:pepper,rule:'known-edge-secret',kind:'credential'}]);
  expect(result).toContainEqual({path:'windows.txt',rule:'supabase-api-key',kind:'credential'});
  expect(result).toContainEqual({path:'windows.txt',rule:'known-edge-secret',kind:'credential'});
  expect(JSON.stringify(result)).not.toContain(key);expect(JSON.stringify(result)).not.toContain(pepper);
});
it('detects a UTF-16 deployment reference inside a ZIP download',()=>{
  const project='z'.repeat(20),bytes=utf16('https://'+project+'.supabase.co',true,true);
  const result=inspectSecretBytes(zipSync({'windows.txt':bytes}),'download.zip');
  expect(result).toContainEqual({path:'download.zip!windows.txt',rule:'supabase-deployment-url',kind:'deployment'});
  expect(JSON.stringify(result)).not.toContain(project);
});
it('detects a privileged Supabase key without returning any credential value',()=>{const result=inspectSecretBytes(Buffer.from('const key="'+key+'"'),'sample.js');expect(result).toContainEqual({path:'sample.js',rule:'supabase-api-key',kind:'credential'});expect(JSON.stringify(result)).not.toContain(key);});
it('checks exact private values including a pepper that has no recognizable prefix',()=>{const value='a19f'.repeat(16);const known=inspectSecretBytes(Buffer.from('PEPPER='+value),'config',[{value,rule:'known-edge-secret',kind:'credential'}]);expect(known[0].rule).toBe('known-edge-secret');expect(JSON.stringify(known)).not.toContain(value);});
it('checks keys hidden inside a published ZIP archive',()=>{const archive=zipSync({'bundle.js':strToU8('const credential="'+key+'"')});expect(inspectSecretBytes(archive,'download.zip')).toContainEqual({path:'download.zip!bundle.js',rule:'supabase-api-key',kind:'credential'});});
it('accepts env names, regexes, short fake test keys and placeholders',()=>{expect(inspectSecretBytes(Buffer.from('MISE_SERVICE_API_KEY=\nsb_secret_test_only\n/^sb_secret_[A-Za-z0-9_-]+$/\nhttps://<project-ref>.supabase.co'),'example')).toEqual([]);});
it('flags deployment URLs while keeping their actual reference out of findings',()=>{const ref='z'.repeat(20),url='https://'+ref+'.supabase.co';const result=inspectSecretBytes(Buffer.from(url),'notes.md');expect(result).toContainEqual({path:'notes.md',rule:'supabase-deployment-url',kind:'deployment'});expect(JSON.stringify(result)).not.toContain(ref);});
it('redacts credentials even when they appear in a filename',()=>{const result=inspectSecretBytes(Buffer.from(key),key+'.txt');expect(JSON.stringify(result)).not.toContain(key);expect(result[0].path).toBe('[redacted].txt');});
it('rejects a credential in an otherwise empty filename',()=>{const result=inspectSecretBytes(Buffer.alloc(0),key+'.txt');expect(result).toContainEqual({path:'[redacted].txt',rule:'supabase-api-key',kind:'credential'});expect(JSON.stringify(result)).not.toContain(key);});
// These integration fixtures spawn Git/Node processes; they are not latency benchmarks.
const gitFixtureTimeout=30_000;
const guard=resolve('scripts/check-secrets.mjs');
function withRepository(run:(directory:string,git:(...args:string[])=>void)=>void){
  const prefix=join(tmpdir(),'mise-secret-guard-fixture-'),directory=mkdtempSync(prefix);
  const git=(...args:string[])=>{const result=spawnSync('git',['-c','user.name=Secret guard fixture','-c','user.email=fixture@example.invalid',...args],{cwd:directory,encoding:'utf8',windowsHide:true});expect(result.status).toBe(0);};
  try{git('init','--quiet');run(directory,git);}finally{if(!resolve(directory).startsWith(resolve(prefix)))throw new Error('Invalid fixture cleanup path.');rmSync(directory,{recursive:true,force:true});}
}
function scanUsing(script:string,directory:string,...args:string[]){const result=spawnSync(process.execPath,[script,...args],{cwd:directory,encoding:'utf8',windowsHide:true});expect(result.stderr).toBe('');expect(result.stdout).not.toContain(key);return {status:result.status,report:JSON.parse(result.stdout)};}
function scan(directory:string,...args:string[]){return scanUsing(guard,directory,...args);}
function withHistoricalPolicy(fingerprints:string[],run:(script:string,policy:string)=>void){
  mkdirSync(resolve('.private'),{recursive:true});const prefix=resolve('.private/mise-history-policy-fixture-'),directory=mkdtempSync(prefix),script=join(directory,'check-secrets.mjs'),policy=join(directory,'legacy-deployment-findings.json');
  try{copyFileSync(guard,script);writeFileSync(policy,JSON.stringify({version:1,baseline:'0'.repeat(40),fingerprints:[...new Set(fingerprints)].sort()}));run(script,policy);}
  finally{if(!resolve(directory).startsWith(prefix))throw Error('Invalid policy fixture cleanup path.');rmSync(directory,{recursive:true,force:true});}
}
it('rejects a staged secret even after its working copy was sanitized',()=>withRepository((directory,git)=>{writeFileSync(join(directory,'config.txt'),key);git('add','config.txt');writeFileSync(join(directory,'config.txt'),'placeholder');const result=scan(directory);expect(result.status).toBe(1);expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^index:/),rule:'supabase-api-key'}));}),gitFixtureTimeout);
it('finds historical credentials after a later commit removed them',()=>withRepository((directory,git)=>{writeFileSync(join(directory,'config.txt'),key);git('add','config.txt');git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','fixture');writeFileSync(join(directory,'config.txt'),'placeholder');git('add','config.txt');git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','sanitized fixture');expect(scan(directory).status).toBe(0);const result=scan(directory,'--history');expect(result.status).toBe(1);expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^history:/),rule:'supabase-api-key'}));}),gitFixtureTimeout);
it('allows an ignored local env file and a blank tracked template',()=>withRepository((directory,git)=>{writeFileSync(join(directory,'.gitignore'),'.env\n');writeFileSync(join(directory,'.env'),key);writeFileSync(join(directory,'.env.example'),'MISE_SERVICE_API_KEY=\n');git('add','.gitignore','.env.example');expect(scan(directory).status).toBe(0);}),gitFixtureTimeout);
it.each(['MISE_STAFF_PIN_PEPPER_V1','MISE_SYNC_CURSOR_KEY_V1'])('automatically checks private %s values without publishing their path',secretName=>withRepository((directory,git)=>{
  const privateDirectory=mkdtempSync(join(tmpdir(),'mise-private-scan-fixture-')),pepper='f17c'.repeat(16);
  try{writeFileSync(join(privateDirectory,'api-keys.json'),'{}');writeFileSync(join(privateDirectory,'edge.env'),secretName+'='+pepper+'\n');git('config','--local','mise.secretScanDirectory',privateDirectory);
    writeFileSync(join(directory,'notes.txt'),pepper);git('add','notes.txt');writeFileSync(join(directory,'notes.txt'),'safe working copy');
    const result=scan(directory);expect(result.status).toBe(1);expect(result.report.knownValuesChecked).toBe(1);expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^index:/),rule:'known-edge-secret'}));expect(JSON.stringify(result.report)).not.toContain(pepper);expect(JSON.stringify(result.report)).not.toContain(privateDirectory);
  }finally{if(!resolve(privateDirectory).startsWith(resolve(join(tmpdir(),'mise-private-scan-fixture-'))))throw new Error('Invalid private fixture cleanup path.');rmSync(privateDirectory,{recursive:true,force:true});}
}),gitFixtureTimeout);
it('blocks plain project and organization references configured only in local Git',()=>withRepository((directory,git)=>{
  const project='z'.repeat(20),organization='y'.repeat(20);git('config','--local','--add','mise.privateDeploymentRef',project);git('config','--local','--add','mise.privateDeploymentRef',organization);
  writeFileSync(join(directory,'notes.txt'),project+'\n'+organization);git('add','notes.txt');const result=scan(directory);expect(result.status).toBe(1);expect(result.report.knownValuesChecked).toBe(2);expect(result.report.currentDeploymentFindings).toBeGreaterThanOrEqual(2);expect(JSON.stringify(result.report)).not.toContain(project);expect(JSON.stringify(result.report)).not.toContain(organization);
}),gitFixtureTimeout);
it('fails closed when a configured private audit directory is unavailable',()=>withRepository((directory,git)=>{
  git('config','--local','mise.secretScanDirectory',join(directory,'missing-private-config'));const result=spawnSync(process.execPath,[guard],{cwd:directory,encoding:'utf8',windowsHide:true});expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(JSON.parse(result.stderr).ok).toBe(false);expect(result.stderr).not.toContain(directory);
}),gitFixtureTimeout);
it('finds secrets in commit and annotated tag messages',()=>withRepository((directory,git)=>{
  writeFileSync(join(directory,'safe.txt'),'safe');git('add','safe.txt');
  git('-c','core.hooksPath=/dev/null','commit','--quiet','-m',key);git('tag','-a','fixture','-m',key);
  const result=scan(directory,'--history');expect(result.status).toBe(1);
  expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^history:.*:commit$/),rule:'supabase-api-key'}));
  expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^history:.*:tag:fixture$/),rule:'supabase-api-key'}));
}),gitFixtureTimeout);
function installHook(directory:string,git:(...args:string[])=>void,hook:string,script=guard){
  mkdirSync(join(directory,'scripts'));
  writeFileSync(join(directory,'scripts/check-secrets.mjs'),`import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,[${JSON.stringify(script)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);`);
  mkdirSync(join(directory,'.githooks'));const target=join(directory,'.githooks',hook);
  copyFileSync(resolve('.githooks',hook),target);chmodSync(target,0o755);git('config','core.hooksPath','.githooks');
}
it('blocks a real commit with a staged secret through the installed hook',()=>withRepository((directory,git)=>{
  installHook(directory,git,'pre-commit');writeFileSync(join(directory,'config.txt'),key);git('add','config.txt');
  const result=spawnSync('git',['-c','user.name=Secret guard fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','must be blocked'],{cwd:directory,encoding:'utf8',windowsHide:true});
  expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).not.toContain(key);expect(result.stdout+result.stderr).toContain('supabase-api-key');
  writeFileSync(join(directory,'config.txt'),'placeholder');git('add','config.txt');git('commit','--quiet','-m','safe commit');
}),gitFixtureTimeout);
it('blocks a real commit containing a PowerShell UTF-16 secret',()=>withRepository((directory,git)=>{
  installHook(directory,git,'pre-commit');writeFileSync(join(directory,'windows.txt'),utf16(key,false,true));git('add','windows.txt');
  const result=spawnSync('git',['-c','user.name=Secret guard fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','must be blocked'],{cwd:directory,encoding:'utf8',windowsHide:true});
  expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).not.toContain(key);expect(result.stdout+result.stderr).toContain('supabase-api-key');
  expect(spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:directory,encoding:'utf8',windowsHide:true}).status).not.toBe(0);
}),gitFixtureTimeout);
it('blocks a real push when a credential remains only in history',()=>withRepository((directory,git)=>{
  installHook(directory,git,'pre-push');writeFileSync(join(directory,'.gitignore'),'remote.git/\n');writeFileSync(join(directory,'config.txt'),key);git('add','.gitignore','config.txt');
  git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','historical fixture');
  writeFileSync(join(directory,'config.txt'),'placeholder');git('add','config.txt');git('commit','--quiet','-m','safe current file');
  git('init','--bare','--quiet','remote.git');git('remote','add','fixture',join(directory,'remote.git'));
  const result=spawnSync('git',['push','fixture','HEAD:refs/heads/main'],{cwd:directory,encoding:'utf8',windowsHide:true});
  expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).not.toContain(key);expect(result.stdout+result.stderr).toContain('supabase-api-key');
  const remote=spawnSync('git',['--git-dir=remote.git','show-ref'],{cwd:directory,encoding:'utf8',windowsHide:true});expect(remote.status).toBe(1);
}),gitFixtureTimeout);

it('rejects a newly introduced deployment URL after its current file was cleaned',()=>withRepository((directory,git)=>{
  const project='z'.repeat(20),url='https://'+project+'.supabase.co';
  writeFileSync(join(directory,'notes.txt'),url);git('add','notes.txt');git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','historical deployment fixture');
  writeFileSync(join(directory,'notes.txt'),'safe');git('add','notes.txt');git('commit','--quiet','-m','clean current file');
  const result=scan(directory,'--history');expect(JSON.stringify(result.report)).not.toContain(project);expect(result.report.historicalDeploymentFindings).toBeGreaterThan(0);expect(result.status).toBe(1);
}),gitFixtureTimeout);

it.each(['commit','tag'])('rejects a new deployment URL in a %s message',kind=>withRepository((directory,git)=>{
  const project='z'.repeat(20),url='https://'+project+'.supabase.co';writeFileSync(join(directory,'safe.txt'),'safe');git('add','safe.txt');git('commit','--quiet','-m','safe fixture');
  if(kind==='commit')git('-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m',url);else git('tag','-a','fixture','-m',url);
  const result=scan(directory,'--history');expect(JSON.stringify(result.report)).not.toContain(project);expect(result.status).toBe(1);
}),gitFixtureTimeout);

it('finds a historical credential filename when its empty blob is also used by a safe file',()=>withRepository((directory,git)=>{
  writeFileSync(join(directory,'safe.txt'),'');writeFileSync(join(directory,key),'');git('add','safe.txt',key);git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','filename fixture');
  rmSync(join(directory,key));git('add','--all');git('commit','--quiet','-m','safe current names');
  const result=scan(directory,'--history');expect(result.report.credentialFindings).toBeGreaterThan(0);expect(result.status).toBe(1);
}),gitFixtureTimeout);

it('rejects a historical project filename even when a safe filename reuses the same empty blob',()=>withRepository((directory,git)=>{
  const project='z'.repeat(20);git('config','--local','--add','mise.privateDeploymentRef',project);writeFileSync(join(directory,'safe.txt'),'');writeFileSync(join(directory,project),'');git('add','safe.txt',project);git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','filename fixture');
  rmSync(join(directory,project));git('add','--all');git('commit','--quiet','-m','safe current names');
  const result=scan(directory,'--history');expect(JSON.stringify(result.report)).not.toContain(project);expect(result.report.blockedHistoricalDeploymentFindings).toBeGreaterThan(0);expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^history:.*:tree$/),rule:'known-deployment-reference'}));expect(result.status).toBe(1);
}),gitFixtureTimeout);

it.each(['tag','branch','unborn branch'])('rejects a private deployment identifier in a %s name',kind=>withRepository((directory,git)=>{
  const project='z'.repeat(20);git('config','--local','--add','mise.privateDeploymentRef',project);writeFileSync(join(directory,'safe.txt'),'safe');git('add','safe.txt');
  if(kind==='unborn branch')git('symbolic-ref','HEAD','refs/heads/'+project);else{git('commit','--quiet','-m','safe fixture');git(kind,project);}
  const result=scan(directory);expect(JSON.stringify(result.report)).not.toContain(project);expect(result.report.findings).toContainEqual(expect.objectContaining({path:expect.stringMatching(/^ref:/),rule:'known-deployment-reference'}));expect(result.status).toBe(1);
}),gitFixtureTimeout);

it('blocks an incomplete shallow-history audit without printing its private checkout path',()=>withRepository((directory,git)=>{
  writeFileSync(join(directory,'safe.txt'),'first');git('add','safe.txt');git('commit','--quiet','-m','first fixture');writeFileSync(join(directory,'safe.txt'),'second');git('add','safe.txt');git('commit','--quiet','-m','second fixture');
  const clone=join(directory,'shallow');git('-c','protocol.file.allow=always','clone','--quiet','--depth=1',pathToFileURL(directory).href,clone);
  const result=spawnSync(process.execPath,[guard,'--history'],{cwd:clone,encoding:'utf8',windowsHide:true});expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(JSON.parse(result.stderr).ok).toBe(false);expect(result.stderr).not.toContain(clone);
}),gitFixtureTimeout);

it('permits only reviewed old deployment objects and blocks a real push of a later identifier',()=>withRepository((directory,git)=>{
  const oldProject='z'.repeat(20),newProject='y'.repeat(20);writeFileSync(join(directory,'.gitignore'),'remote.git/\n');writeFileSync(join(directory,'notes.txt'),'https://'+oldProject+'.supabase.co');git('add','.gitignore','notes.txt');git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','legacy fixture');writeFileSync(join(directory,'notes.txt'),'safe');git('add','notes.txt');git('commit','--quiet','-m','safe current file');
  const unreviewed=scan(directory,'--history');expect(unreviewed.status).toBe(1);const fingerprints=unreviewed.report.findings.filter((finding:{kind:string;fingerprint?:string})=>finding.kind==='deployment').map((finding:{fingerprint:string})=>finding.fingerprint);expect(fingerprints.length).toBeGreaterThan(0);
  withHistoricalPolicy(fingerprints,script=>{
    const accepted=scanUsing(script,directory,'--history');expect(accepted.status).toBe(0);expect(accepted.report.legacyDeploymentFindings).toBeGreaterThan(0);expect(accepted.report.blockedHistoricalDeploymentFindings).toBe(0);
    installHook(directory,git,'pre-push',script);git('add','scripts','.githooks');git('commit','--quiet','-m','install fixture guard');git('init','--bare','--quiet','remote.git');git('remote','add','fixture',join(directory,'remote.git'));git('push','--quiet','fixture','HEAD:refs/heads/main');
    const before=spawnSync('git',['--git-dir=remote.git','rev-parse','refs/heads/main'],{cwd:directory,encoding:'utf8',windowsHide:true});expect(before.status).toBe(0);
    git('-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m','https://'+newProject+'.supabase.co');const rejected=scanUsing(script,directory,'--history');expect(rejected.status).toBe(1);expect(rejected.report.legacyDeploymentFindings).toBe(accepted.report.legacyDeploymentFindings);expect(rejected.report.blockedHistoricalDeploymentFindings).toBeGreaterThan(0);expect(JSON.stringify(rejected.report)).not.toContain(newProject);
    const pushed=spawnSync('git',['push','fixture','HEAD:refs/heads/main'],{cwd:directory,encoding:'utf8',windowsHide:true});expect(pushed.status).not.toBe(0);expect(pushed.stdout+pushed.stderr).not.toContain(newProject);expect(pushed.stdout+pushed.stderr).toContain('blockedHistoricalDeploymentFindings');const after=spawnSync('git',['--git-dir=remote.git','rev-parse','refs/heads/main'],{cwd:directory,encoding:'utf8',windowsHide:true});expect(after.stdout).toBe(before.stdout);
  });
}),gitFixtureTimeout);

it('never treats a credential as an allowed historical deployment finding',()=>withRepository((directory,git)=>{
  writeFileSync(join(directory,'notes.txt'),key);git('add','notes.txt');git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','credential fixture');writeFileSync(join(directory,'notes.txt'),'safe');git('add','notes.txt');git('commit','--quiet','-m','safe current file');
  const forged=createHash('sha256').update('blob').update('\0').update(key).update('\0').update('supabase-api-key').digest('hex');withHistoricalPolicy([forged],script=>{const result=scanUsing(script,directory,'--history');expect(result.status).toBe(1);expect(result.report.credentialFindings).toBeGreaterThan(0);expect(result.report.legacyDeploymentFindings).toBe(0);});
}),gitFixtureTimeout);

it('fails closed when the reviewed historical policy is unavailable',()=>withRepository((directory,git)=>{
  writeFileSync(join(directory,'safe.txt'),'safe');git('add','safe.txt');withHistoricalPolicy([],(script,policy)=>{rmSync(policy);const result=spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8',windowsHide:true});expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(JSON.parse(result.stderr).ok).toBe(false);expect(result.stderr).not.toContain(policy);});
}),gitFixtureTimeout);
