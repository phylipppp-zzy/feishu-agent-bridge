import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CONVERSATION_ID_RE, expandHomePath } from './catalog-types.js';

export interface ExternalAgyHolder {
  pid: number;
  tty: string;
  cmdline: string;
}

export type ExternalAgyHolderDetector = (sessionId: string) => ExternalAgyHolder | null;

export interface AgySessionHolder extends ExternalAgyHolder {
  kind: 'external_cli' | 'bridge_acp';
}

function isBridgeAcpProcess(argv: readonly string[]): boolean {
  return argv.includes('acp') || argv.includes('--worker');
}

export function defaultAgyConversationsDir(brainDir?: string): string {
  if (brainDir) {
    return join(dirname(brainDir), 'conversations');
  }
  return join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

export function createProcExternalAgyHolderDetector(
  conversationsDir: string = defaultAgyConversationsDir(),
): ExternalAgyHolderDetector {
  return (sessionId: string): ExternalAgyHolder | null => {
    if (process.platform !== 'linux' || !sessionId || sessionId.includes('/') || sessionId.includes('..')) {
      return null;
    }
    const targetPrefix = `${join(conversationsDir, sessionId)}.db`;
    let pids: string[];
    try {
      pids = readdirSync('/proc');
    } catch {
      return null;
    }
    const selfPid = String(process.pid);
    for (const pidStr of pids) {
      if (pidStr === selfPid || !/^\d+$/.test(pidStr)) continue;
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pidStr}/fd`);
      } catch {
        continue;
      }
      let matched = false;
      for (const fd of fds) {
        let target: string;
        try {
          target = readlinkSync(`/proc/${pidStr}/fd/${fd}`);
        } catch {
          continue;
        }
        if (target === targetPrefix || target === `${targetPrefix}-wal` || target === `${targetPrefix}-shm`) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      let argv: string[] = [];
      try {
        const raw = readFileSync(`/proc/${pidStr}/cmdline`, 'utf8');
        argv = raw.split('\0').filter(Boolean);
      } catch {
        continue;
      }
      if (!argv.length || isBridgeAcpProcess(argv)) continue;
      let tty = '';
      try {
        const stdinTarget = readlinkSync(`/proc/${pidStr}/fd/0`);
        if (stdinTarget.startsWith('/dev/')) tty = stdinTarget;
      } catch {
        // Ignore unreadable stdin symlink.
      }
      return {
        pid: Number(pidStr),
        tty,
        cmdline: argv.join(' '),
      };
    }
    return null;
  };
}

export function formatExternalAgyHolderError(holder: ExternalAgyHolder): string {
  const ttyNote = holder.tty ? `，${holder.tty}` : '';
  return `本地终端 agy（PID ${holder.pid}${ttyNote}）正打开此会话，请等待当前任务完成并退出终端，或停止该终端进程后再在飞书继续。`;
}

export function scanAgySessionHolders(
  conversationsDir: string = defaultAgyConversationsDir(),
  procRoot = '/proc',
): Map<string, AgySessionHolder[]> {
  const holders = new Map<string, AgySessionHolder[]>();
  if (process.platform !== 'linux') return holders;
  let pids: string[];
  try {
    pids = readdirSync(procRoot);
  } catch {
    return holders;
  }
  const dir = resolve(expandHomePath(conversationsDir));
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const pidDir = join(procRoot, pid);
    const fdDir = join(pidDir, 'fd');
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    const sessionIds = new Set<string>();
    let tty = '';
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(join(fdDir, fd));
      } catch {
        continue;
      }
      if (fd === '0' && target.startsWith('/dev/')) tty = target;
      if (!target.startsWith(prefix)) continue;
      const id = /^(.+)\.db(?:-wal|-shm)?$/.exec(target.slice(prefix.length))?.[1];
      if (id && id !== '.' && !id.includes('..') && CONVERSATION_ID_RE.test(id)) sessionIds.add(id);
    }
    if (!sessionIds.size) continue;
    let argv: string[];
    try {
      argv = readFileSync(join(pidDir, 'cmdline'), 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.length) continue;
    const holder: AgySessionHolder = {
      pid: Number(pid),
      tty,
      cmdline: argv.join(' '),
      kind: isBridgeAcpProcess(argv) ? 'bridge_acp' : 'external_cli',
    };
    for (const id of sessionIds) {
      const existing = holders.get(id);
      if (existing) existing.push(holder);
      else holders.set(id, [holder]);
    }
  }
  return holders;
}
