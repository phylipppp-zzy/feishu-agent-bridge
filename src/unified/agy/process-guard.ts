import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ExternalAgyHolder {
  pid: number;
  tty: string;
  cmdline: string;
}

export type ExternalAgyHolderDetector = (sessionId: string) => ExternalAgyHolder | null;

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
