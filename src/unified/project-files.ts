import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { LIST_MAX_ENTRIES, type DirectoryEntry, type DirectoryListing } from '../claude/deliver.js';

const privateDirs = new Set(['.git','.ssh','.gnupg','.aws','.kube','.docker','.config','.claude']);
const secretName = /^\.env(?:\..*)?$|^\.(?:netrc|npmrc|pypirc|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx|jks|keystore)$|secret|credential|passw/i;
const hidden = (name:string) => privateDirs.has(name) || secretName.test(name);
/** Walk from a trusted project directory without following any caller-controlled symlink. */
export async function listSafeProjectDirectory(arg:string, root:string, showHidden:boolean):Promise<DirectoryListing> {
  const path=resolve(root,arg || '.'); const rel=relative(root,path);
  if(isAbsolute(rel) || rel==='..' || rel.startsWith(`..${sep}`)) return {kind:'error',message:'只能查看项目目录内的内容。'};
  const parts=rel ? rel.split(sep) : [];
  if(parts.some(hidden)) return {kind:'error',message:'这个路径不对飞书开放。'};
  const handles:Awaited<ReturnType<typeof open>>[]=[];
  try {
    let dir=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); handles.push(dir);
    for(let i=0;i<parts.length;i++) {
      const name=parts[i]!; const entryPath=`/proc/self/fd/${dir.fd}/${name}`; const info=await lstat(entryPath);
      if(info.isSymbolicLink()) return {kind:'error',message:'不支持查看符号链接。'};
      if(i===parts.length-1 && info.isFile()) return {kind:'file',path,entry:{name,kind:'file',size:info.size,mtimeMs:info.mtimeMs}};
      if(!info.isDirectory()) return {kind:'error',message:'无法读取目录。'};
      dir=await open(entryPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(dir);
    }
    const names=await readdir(`/proc/self/fd/${dir.fd}`); const visible=names.filter(n=>!hidden(n) && (showHidden || !n.startsWith('.')));const entries:DirectoryEntry[]=[];
    for(const name of visible) { const info=await lstat(`/proc/self/fd/${dir.fd}/${name}`).catch(()=>null); if(!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue; entries.push({name,kind:info.isDirectory()?'dir':'file',size:info.isDirectory()?0:info.size,mtimeMs:info.mtimeMs}); }
    entries.sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):a.kind==='dir'?-1:1);
    return {kind:'dir',path,entries:entries.slice(0,LIST_MAX_ENTRIES),total:entries.length,hidden:names.filter(n=>!hidden(n) && !showHidden && n.startsWith('.')).length,parent:path!==root?resolve(path,'..'):null};
  } catch {return {kind:'error',message:'无法读取目录或文件。'};} finally {await Promise.all(handles.reverse().map(h=>h.close()));}
}
