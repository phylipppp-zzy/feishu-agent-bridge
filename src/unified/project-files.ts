import { constants, existsSync, realpathSync } from 'node:fs';
import { lstat, open, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIST_MAX_ENTRIES, type DirectoryEntry, type DirectoryListing } from '../claude/deliver.js';

const privateDirs = new Set(['.git','.ssh','.gnupg','.aws','.kube','.docker','.config','.claude','reviews','projtool']);
const secretName = /^\.env(?:\..*)?$|^\.(?:netrc|npmrc|pypirc|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx|jks|keystore)$|secret|credential|passw/i;
const hidden = (name:string) => privateDirs.has(name) || secretName.test(name);

function isInsideRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function confidentialHomeRoots(): string[] {
  const homes = new Set<string>();
  if (process.env.HOME?.trim()) homes.add(resolve(process.env.HOME.trim()));
  homes.add(resolve(homedir()));
  const roots: string[] = [];
  for (const h of homes) {
    for (const sub of ['reviews', join('projects', 'projtool')]) {
      const candidate = join(h, sub);
      if (!roots.includes(candidate)) roots.push(candidate);
      try {
        if (existsSync(candidate)) {
          const real = realpathSync(candidate);
          if (!roots.includes(real)) roots.push(real);
        }
      } catch {
        // ignore unreadable home subdirs
      }
    }
  }
  return roots;
}

function isProtectedConfidentialPath(canonicalTarget: string): boolean {
  const segments = canonicalTarget.split(sep).filter(Boolean);
  if (segments.some(seg => seg === 'reviews' || seg === 'projtool')) return true;
  return confidentialHomeRoots().some(root => isInsideRoot(canonicalTarget, root));
}

async function canonicalizeWhitelistRoots(roots?: readonly string[]): Promise<string[]> {
  if (!roots?.length) return [];
  const result: string[] = [];
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) continue;
    try {
      const real = await realpath(resolve(r));
      if (!result.includes(real)) result.push(real);
    } catch {
      // Ignore non-existent configured roots.
    }
  }
  return result;
}

async function resolveWhitelistedSymlink(entryPath: string, whitelistRoots: readonly string[]): Promise<string | null> {
  if (whitelistRoots.length === 0) return null;
  let target: string;
  try {
    target = await realpath(entryPath);
  } catch {
    return null;
  }
  if (isProtectedConfidentialPath(target)) return null;
  const matchedRoot = whitelistRoots.find(r => isInsideRoot(target, r));
  if (!matchedRoot) return null;
  const rel = relative(matchedRoot, target);
  const parts = rel ? rel.split(sep).filter(Boolean) : [];
  if (parts.some(hidden) || hidden(basename(target))) return null;
  return target;
}

/** Walk from a trusted project directory; symlinks are allowed only when their realpath falls inside allowedSymlinkRoots. */
export async function listSafeProjectDirectory(
  arg: string,
  root: string,
  showHidden: boolean,
  allowedSymlinkRoots?: readonly string[],
): Promise<DirectoryListing> {
  const path=resolve(root,arg || '.'); const rel=relative(root,path);
  if(isAbsolute(rel) || rel==='..' || rel.startsWith(`..${sep}`)) return {kind:'error',message:'只能查看项目目录内的内容。'};
  const parts=rel ? rel.split(sep) : [];
  if(parts.some(hidden)) return {kind:'error',message:'这个路径不对飞书开放。'};
  const whitelistRoots = await canonicalizeWhitelistRoots(allowedSymlinkRoots);
  const handles:Awaited<ReturnType<typeof open>>[]=[];
  try {
    let dir=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); handles.push(dir);
    for(let i=0;i<parts.length;i++) {
      const name=parts[i]!; const entryPath=`/proc/self/fd/${dir.fd}/${name}`; const info=await lstat(entryPath);
      if(info.isSymbolicLink()) {
        const target = await resolveWhitelistedSymlink(entryPath, whitelistRoots);
        if (!target) return {kind:'error',message:'不支持查看越界或未授权的符号链接。'};
        const targetInfo = await stat(target);
        if(i===parts.length-1 && targetInfo.isFile()) return {kind:'file',path,entry:{name,kind:'file',size:targetInfo.size,mtimeMs:targetInfo.mtimeMs}};
        if(!targetInfo.isDirectory()) return {kind:'error',message:'无法读取目录。'};
        dir=await open(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); handles.push(dir);
        const fdPath = await realpath(`/proc/self/fd/${dir.fd}`).catch(() => target);
        if (fdPath !== target || !whitelistRoots.some(r => isInsideRoot(fdPath, r))) return {kind:'error',message:'不支持查看越界或未授权的符号链接。'};
        continue;
      }
      if(i===parts.length-1 && info.isFile()) return {kind:'file',path,entry:{name,kind:'file',size:info.size,mtimeMs:info.mtimeMs}};
      if(!info.isDirectory()) return {kind:'error',message:'无法读取目录。'};
      dir=await open(entryPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(dir);
    }
    const names=await readdir(`/proc/self/fd/${dir.fd}`); const visible=names.filter(n=>!hidden(n) && (showHidden || !n.startsWith('.')));const entries:DirectoryEntry[]=[];
    for(const name of visible) {
      const entryPath = `/proc/self/fd/${dir.fd}/${name}`;
      const info=await lstat(entryPath).catch(()=>null);
      if(!info) continue;
      if(info.isSymbolicLink()) {
        const target = await resolveWhitelistedSymlink(entryPath, whitelistRoots);
        if(!target) continue;
        const targetInfo = await stat(target).catch(()=>null);
        if(!targetInfo || (!targetInfo.isDirectory() && !targetInfo.isFile())) continue;
        entries.push({name,kind:targetInfo.isDirectory()?'dir':'file',size:targetInfo.isDirectory()?0:targetInfo.size,mtimeMs:targetInfo.mtimeMs});
        continue;
      }
      if(!info.isDirectory() && !info.isFile()) continue;
      entries.push({name,kind:info.isDirectory()?'dir':'file',size:info.isDirectory()?0:info.size,mtimeMs:info.mtimeMs});
    }
    entries.sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):a.kind==='dir'?-1:1);
    return {kind:'dir',path,entries:entries.slice(0,LIST_MAX_ENTRIES),total:entries.length,hidden:names.filter(n=>!hidden(n) && !showHidden && n.startsWith('.')).length,parent:path!==root?resolve(path,'..'):null};
  } catch {return {kind:'error',message:'无法读取目录或文件。'};} finally {await Promise.all(handles.reverse().map(h=>h.close()));}
}

/** Expand user-provided project patterns; symlinks are followed only when their realpath falls inside allowedSymlinkRoots. */
export async function selectSafeProjectFiles(
  root: string,
  raw: string,
  allowedSymlinkRoots?: readonly string[],
): Promise<Array<{path:string; digest:string}>> {
  const { matchesGlob } = await import('node:path'); const { createHash } = await import('node:crypto');
  if(!raw || raw.length>4096 || /[\n\r\0]/.test(raw)) throw Error('invalid selection');
  const args:string[]=[];const tokens=/\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;let pos=0;
  while(pos<raw.length) {tokens.lastIndex=pos;const m=tokens.exec(raw);if(!m) {if(raw.slice(pos).trim()) throw Error('invalid quoting');break;}args.push(m[1] ?? m[2] ?? m[3]!);pos=tokens.lastIndex;}
  if(!args.length || args.length>20) throw Error('invalid selection');
  const patterns=args.map(arg=>{if(!arg || arg.length>1024 || /[{}\\!()]/.test(arg)) throw Error('unsupported pattern');const parts=arg.split('/');if(parts.includes('..') || parts.some(x=>x.includes('**') && x!=='**') || parts.length>32) throw Error('invalid pattern'); for(const part of parts) {let bracket=false, count=0;for(const ch of part){if(ch==='['){if(bracket)throw Error('invalid pattern');bracket=true;count=0;} else if(ch===']'){if(!bracket || !count)throw Error('invalid pattern');bracket=false;} else if(bracket)count++;}if(bracket)throw Error('invalid pattern');}const full=resolve(root,arg);const rel=relative(root,full);if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`)) throw Error('outside project');return (rel ? rel.split(sep) : []).filter(x=>x!=='.');});
  const whitelistRoots = await canonicalizeWhitelistRoots(allowedSymlinkRoots);
  const selected=new Map<string,string>();let visited=0,total=0,matches=0;
  const namesIn=async(dir:Awaited<ReturnType<typeof open>>)=>{const names:string[]=[];const stream=await opendir(`/proc/self/fd/${dir.fd}`);for await(const entry of stream){if(++visited>10000)throw Error('scan exceeds limit');names.push(entry.name);}return names.sort();};
  const rootHandle=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const flags=constants.O_RDONLY|constants.O_NOFOLLOW;
  const add=async(dir:Awaited<ReturnType<typeof open>>,name:string,path:string,resolvedTarget?:string)=>{matches++;const file=await open(resolvedTarget ?? `/proc/self/fd/${dir.fd}/${name}`,flags);try{if(resolvedTarget){const fdPath=await realpath(`/proc/self/fd/${file.fd}`).catch(()=>resolvedTarget);if(fdPath!==resolvedTarget || !whitelistRoots.some(r=>isInsideRoot(fdPath,r))) throw Error('symlink selection');}const st=await file.stat();if(!st.isFile() || st.size<=0 || st.size>20*1024*1024) throw Error('invalid file size');const buffer=Buffer.alloc(st.size+1);let n=0;while(n<buffer.length){const r=await file.read(buffer,n,buffer.length-n,n);if(!r.bytesRead) break;n+=r.bytesRead;}if(n!==st.size) throw Error('file changed');const digest=createHash('sha256').update(buffer.subarray(0,n)).digest('hex');if(!selected.has(path)){total+=n;if(total>20*1024*1024 || selected.size>=20) throw Error('selection exceeds limit');selected.set(path,digest);} else if(selected.get(path)!==digest) throw Error('file changed');}finally{await file.close();}};
  const walk=async(dir:Awaited<ReturnType<typeof open>>,parts:string[],index:number,segments:string[],depth:number):Promise<void>=>{
    if(depth>32 || ++visited>10000) throw Error('scan exceeds limit');
    if(index===parts.length) {
      const names=await namesIn(dir);
      for(const name of names){
        if(++visited>10000)throw Error('scan exceeds limit');
        if(name.startsWith('.')) continue;
        if(hidden(name)) throw Error('private selection');
        const entryPath=`/proc/self/fd/${dir.fd}/${name}`;
        const info=await lstat(entryPath);
        if(info.isSymbolicLink()) {
          const target=await resolveWhitelistedSymlink(entryPath,whitelistRoots);
          if(!target) throw Error('symlink selection');
          const targetInfo=await stat(target);
          if(targetInfo.isFile()) await add(dir,name,resolve(root,...segments,name),target);
          continue;
        }
        if(info.isFile()) await add(dir,name,resolve(root,...segments,name));
      }
      return;
    }
    const part=parts[index]!;const wild=part==='**'||/[?*\[]/.test(part); const names=wild ? await namesIn(dir) : [part];
    if(part==='**') await walk(dir,parts,index+1,segments,depth);
    for(const name of names){
      if(++visited>10000)throw Error('scan exceeds limit');
      if(name==='.'||name==='..') continue;
      if(part==='**' && name.startsWith('.')) continue;
      if(part!=='**' && wild && name.startsWith('.') && !part.startsWith('.')) continue;
      if(part!=='**' && wild && !matchesGlob(name,part))continue;
      if(hidden(name)){if(part!=='**')throw Error('private selection');continue;}
      const entryPath=`/proc/self/fd/${dir.fd}/${name}`;
      const info=await lstat(entryPath);
      const next=[...segments,name];
      if(info.isSymbolicLink()){
        const target=await resolveWhitelistedSymlink(entryPath,whitelistRoots);
        if(!target){if(part==='**')continue;throw Error('symlink selection');}
        const targetInfo=await stat(target);
        if(targetInfo.isDirectory()){
          if(wild && part!=='**' && index===parts.length-1) continue;
          const child=await open(target,flags|constants.O_DIRECTORY);
          try{
            const fdPath=await realpath(`/proc/self/fd/${child.fd}`).catch(()=>target);
            if(fdPath!==target || !whitelistRoots.some(r=>isInsideRoot(fdPath,r))) throw Error('symlink selection');
            if(part==='**')await walk(child,parts,index,next,depth+1);
            else await walk(child,parts,index+1,next,depth+1);
          }finally{await child.close();}
        } else if(targetInfo.isFile() && part!=='**' && index===parts.length-1) {
          await add(dir,name,resolve(root,...next),target);
        }
        continue;
      }
      if(info.isDirectory()){if(wild && part!=='**' && index===parts.length-1) continue;const child=await open(entryPath,flags|constants.O_DIRECTORY);try{if(part==='**')await walk(child,parts,index,next,depth+1);else await walk(child,parts,index+1,next,depth+1);}finally{await child.close();}}else if(info.isFile() && part!=='**' && index===parts.length-1) await add(dir,name,resolve(root,...next));
    }
  };
  try {for(const pattern of patterns){const before=matches;await walk(rootHandle,pattern,0,[],0);if(matches===before)throw Error('no matching files');}if(!selected.size)throw Error('no matching files');return [...selected].map(([path,digest])=>({path,digest}));}finally{await rootHandle.close();}
}
