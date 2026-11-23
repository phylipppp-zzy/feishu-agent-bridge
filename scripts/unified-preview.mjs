#!/usr/bin/env node
// Local config shape check only; never connects, reads env, or opens runtime databases.
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateRuntimeConfig } from '../src/unified/runtime.ts';
const [mode, path, ...extra] = process.argv.slice(2);
if (extra.length || !path || !['--template','--validate'].includes(mode)) { console.error('usage: node --import tsx scripts/unified-preview.mjs --template|--validate /absolute/config.json'); process.exitCode=2; }
else if (!isAbsolute(path)) { console.error('configuration path must be absolute'); process.exitCode=2; }
else if (mode === '--template') {
  const config={coreDb:'/replace/private/core.sqlite',channelDb:'/replace/private/channel.sqlite',sdkDb:'/replace/private/sdk.sqlite',artifactStatePath:'/replace/private/artifacts.json',ownerOpenId:'REPLACE_OWNER_OPEN_ID',allowedDestinations:['REPLACE_CHAT_ID'],hostId:'REPLACE_HOST_ID',claudeServiceId:'REPLACE_CLAUDE_SERVICE',codexServiceId:'REPLACE_CODEX_SERVICE',claudeStateDir:'/replace/private/claude-state',codexEndpoint:'ws://127.0.0.1:9999',intervalMs:1000,catalogSources:[],allowedProjectRoots:[],outputRoots:[]};
  await writeFile(path,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600}); console.log('Private placeholder template created; fill it before use.');
} else {
  const config=JSON.parse(await readFile(path,'utf8')); validateRuntimeConfig(config);
  if (!Array.isArray(config.catalogSources) || !Array.isArray(config.allowedProjectRoots) || !Array.isArray(config.outputRoots) || !config.artifactStatePath || typeof config.sdkDb!=='string' || !isAbsolute(config.sdkDb) || [config.coreDb,config.channelDb,config.artifactStatePath].includes(config.sdkDb)) throw new Error('explicit catalog, roots, artifact state and distinct SDK database required');
  console.log('Configuration shape valid; no connections or database access performed. Discovery is disabled for empty sources or project roots. Ensure one runtime per channel and artifact state before explicit start.');
}
