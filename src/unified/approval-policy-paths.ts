import { lstat, opendir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, resolve } from 'node:path';

export type ApprovalContext = {
  cwd?: string;
  project?: string;
  allowedRoots?: readonly string[];
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
  homeDir?: string;
  brainDir?: string;
  enabled?: boolean;
};
export type ApprovalScope = Omit<ApprovalContext, 'project' | 'cwd'>;
export type Check = { kind: 'ask' | 'deny'; reason: string };
type PathProof = { path: string; unresolvedLink: boolean };
type Protection = Check & { path: string };
export interface PolicyPaths {
  home: string;
  project: PathProof | undefined;
  readRoots: string[];
  writeRoots: string[];
  checks: Check[];
  protections: Protection[];
  sensitiveReadRoots: string[];
  pmCheck?: string;
}

export const unknown = '无法确认工具的完整参数或影响范围，需人工审批';
export const outside = '目标超出受信工作区或路径无法核实，需人工审批';
export const systemChange = '提权、登录认证或修改系统、网络与服务配置需人工审批';
export const destructive = '此操作可能丢失本地成果或修改远端历史，需人工审批';
const paperChange = '修改论文目录 papers/ 的内容或署名需人工审批';
const reviewChange = '修改 reviews/ 保密盲审材料需人工审批';
const projectRestriction = 'AGENTS.md 禁止修改 projtool 及其提供的文件';
export const under = (path: string, root: string) => path === root || path.startsWith(root === '/' ? root : `${root}/`);
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/** Resolve in filesystem order, including symlinks before any following "..". */
export async function provePath(path: string, cwd?: string): Promise<PathProof | null> {
  if (!path || path.includes('\0') || (!isAbsolute(path) && !cwd)) return null;
  const absolute = isAbsolute(path) ? path : `${cwd}/${path}`;
  try {
    return { path: await realpath(absolute), unresolvedLink: false };
  } catch (e) {
    if (errno(e) !== 'ENOENT') return null;
  }
  const pending = absolute.split('/');
  let base = '/';
  let links = 0;
  let unresolvedLink = false;
  while (pending.length) {
    const name = pending.shift()!;
    if (!name || name === '.') continue;
    if (name === '..') {
      base = posix.dirname(base);
      continue;
    }
    const candidate = join(base, name);
    try {
      const meta = await lstat(candidate);
      if (meta.isSymbolicLink()) {
        if (++links > 40) return null;
        const target = await readlink(candidate);
        if (isAbsolute(target)) base = '/';
        // Resolve the link target independently from the new file name tail.
        const targetProof = await proveLinkTarget(target, base, 40 - links);
        if (!targetProof) return null;
        base = targetProof.path;
        unresolvedLink ||= targetProof.unresolvedLink;
      } else base = candidate;
    } catch (e) {
      if (errno(e) !== 'ENOENT') return null;
      base = candidate;
    }
  }
  return { path: base, unresolvedLink };
}

async function proveLinkTarget(target: string, base: string, remaining: number): Promise<PathProof | null> {
  const pending = target.split('/');
  let cursor = isAbsolute(target) ? '/' : base;
  let missing = false;
  while (pending.length) {
    const name = pending.shift()!;
    if (!name || name === '.') continue;
    if (name === '..') {
      cursor = posix.dirname(cursor);
      continue;
    }
    const candidate = join(cursor, name);
    try {
      const meta = await lstat(candidate);
      if (meta.isSymbolicLink()) {
        if (--remaining < 0) return null;
        const next = await readlink(candidate);
        if (isAbsolute(next)) cursor = '/';
        pending.unshift(...next.split('/'));
      } else cursor = candidate;
    } catch (e) {
      if (errno(e) !== 'ENOENT') return null;
      missing = true;
      cursor = candidate;
    }
  }
  return { path: cursor, unresolvedLink: missing };
}

const installedSkills = /(?:^|\/)\.(?:claude|codex|agents)\/skills\/(?:ml-research-workflow|image-debug|projtool-bootstrap)(?:\/|$)/;
const installedHooks = /(?:^|\/)(?:\.claude\/hooks\/(?:check-running-instances|check-ssh-train)\.sh|\.codex\/(?:hooks\.json|hooks\/run-claude-pretooluse-hook\.sh))(?:\/|$)/;

function protectedPath(policy: PolicyPaths, path: string, gitMetadata = false): Check | null {
  if (['/CLAUDE.md', '/AGENTS.md'].includes(path)
    || /(?:^|\/)\.claude(?:$|\/(?:commands|settings\.json)(?:\/|$))/.test(path)
    || installedSkills.test(path) || installedHooks.test(path)) {
    return { kind: 'deny', reason: projectRestriction };
  }
  const protection = policy.protections.find(entry => under(path, entry.path));
  if (protection) return { kind: protection.kind, reason: protection.reason };
  if (!gitMetadata && /(?:^|\/)\.git(?:$|\/)/.test(path)) return { kind: 'ask', reason: destructive };
  return null;
}

function protectedAncestor(policy: PolicyPaths, path: string): boolean {
  return policy.protections.some(entry => under(entry.path, path))
    || /(?:^|\/)(?:\.claude\/(?:skills|hooks)|\.codex(?:\/(?:skills|hooks))?|\.agents(?:\/skills)?)$/.test(path);
}

export const ask = (policy: PolicyPaths, reason = unknown) => policy.checks.push({ kind: 'ask', reason });

async function inspectDirectoryContents(policy: PolicyPaths, root: string, grant: boolean): Promise<void> {
  const directories = [root];
  let examined = 0;
  const inspect = (path: string) => {
    const check = protectedPath(policy, path);
    if (check) policy.checks.push(check);
    else if (grant && protectedAncestor(policy, path)) ask(policy, outside);
    return check?.kind === 'deny';
  };
  for (const directory of directories) {
    try {
      for await (const entry of await opendir(directory)) {
        if (++examined > 1024) {
          ask(policy, outside);
          return;
        }
        const path = join(directory, entry.name);
        if (inspect(path)) return;
        if (entry.isDirectory()) directories.push(path);
        if (entry.isSymbolicLink()) {
          const target = await provePath(path);
          if (target && inspect(target.path)) return;
          if (!target || target.unresolvedLink || (grant
            ? !under(target.path, root)
            : !policy.writeRoots.some(allowed => under(target.path, allowed)))) ask(policy, outside);
        }
      }
    } catch {
      ask(policy, outside);
    }
  }
}

export async function makePolicy(context: ApprovalContext, checks: Check[] = []): Promise<PolicyPaths> {
  const home = resolve(context.homeDir ?? homedir());
  const pmCheckPath = join(home, 'scripts/pm-check/pm_check.py');
  const personal: Protection[] = [
    { path: join(home, 'projects/projtool'), kind: 'deny', reason: projectRestriction },
    { path: join(home, 'papers'), kind: 'ask', reason: paperChange },
    { path: join(home, 'reviews'), kind: 'ask', reason: reviewChange },
    ...[join(home, '.ssh'), join(home, '.config'), pmCheckPath, '/etc'].map(path => ({ path, kind: 'ask' as const, reason: systemChange })),
  ];
  const protections = (await Promise.all(personal.map(async entry => {
    const proof = await provePath(entry.path);
    return proof && proof.path !== entry.path ? [entry, { ...entry, path: proof.path }] : [entry];
  }))).flat();
  const proveDirectory = async (root: string): Promise<PathProof | undefined> => {
    if (!isAbsolute(root)) return;
    const proof = await provePath(root);
    if (proof && !proof.unresolvedLink && (await stat(proof.path).catch(() => null))?.isDirectory()) return proof;
  };
  const isBroadRoot = (root: string): boolean => root === '/' || root === home || under(home, root);
  const rawProject = context.project;
  const project = rawProject ? await proveDirectory(rawProject) : undefined;
  const sessionRoots = rawProject && project && project.path !== '/' ? [rawProject] : [];
  const proveRoots = async (roots: readonly string[], filterBroad = false) => (await Promise.all([...new Set([...sessionRoots, ...roots])].map(async root => {
    const isSessionRoot = root === rawProject;
    const proof = isSessionRoot ? project : await proveDirectory(root);
    if (!proof) return [];
    const logical = resolve(root);
    if (filterBroad && !isSessionRoot && (isBroadRoot(logical) || isBroadRoot(proof.path))) return [];
    if (logical === proof.path || root !== logical && (await provePath(logical))?.path !== proof.path) return [proof.path];
    return [logical, proof.path];
  }))).flat();
  const [allowedReadRoots, explicitReadRoots, writeRoots] = await Promise.all([
    proveRoots(context.allowedRoots ?? [], true),
    proveRoots(context.readRoots ?? [], false),
    proveRoots(context.writeRoots ?? [], false),
  ]);
  const readRoots = [...new Set([...allowedReadRoots, ...explicitReadRoots])];
  const sensitiveReadLogical = [join(home, 'reviews'), join(home, '.ssh')];
  const sensitiveReadRoots = [...new Set((await Promise.all(sensitiveReadLogical.map(async entry => {
    const proof = await provePath(entry);
    return proof && proof.path !== entry ? [entry, proof.path] : [entry];
  }))).flat())];
  const script = await provePath(pmCheckPath);
  const pmCheck = script && !script.unresolvedLink && (await stat(script.path).catch(() => null))?.isFile() ? script.path : undefined;
  return { home, project, readRoots, writeRoots, checks, protections, sensitiveReadRoots, ...(pmCheck ? { pmCheck } : {}) };
}

export async function inspectPath(policy: PolicyPaths, path: string, cwd: string | undefined, write: boolean, remove = false, gitMetadata = false): Promise<string | undefined> {
  if (!path || (!isAbsolute(path) && !cwd) || path.startsWith('~')) {
    ask(policy, outside);
    return;
  }
  const lexical = resolve(cwd ?? '/', path);
  const proof = await provePath(path, cwd);
  const targets = new Set([lexical, ...(proof ? [proof.path] : [])]);
  const roots = write ? policy.writeRoots : policy.readRoots;
  for (const target of targets) {
    const check = write ? protectedPath(policy, target, gitMetadata) : null;
    if (check) policy.checks.push(check);
    else if (!write && policy.sensitiveReadRoots.some(root => under(target, root) && (!policy.project || !under(policy.project.path, root)))) {
      ask(policy, outside);
    }
    else if (!roots.some(root => under(target, root))) ask(policy, outside);
    if (remove && (
      target === join(policy.home, 'projects')
      || policy.protections.some(entry => entry.kind === 'deny' && target === posix.dirname(entry.path))
    )) policy.checks.push({ kind: 'deny', reason: projectRestriction });
    if (remove && (
      protectedAncestor(policy, target) || roots.includes(target)
      || !policy.project || target === policy.project.path || !under(target, policy.project.path)
    )) ask(policy, destructive);
  }
  if (!proof || proof.unresolvedLink) ask(policy, outside);
  else if (remove && !policy.checks.some(check => check.kind === 'deny')) {
    try {
      if ((await lstat(proof.path)).isDirectory()) await inspectDirectoryContents(policy, proof.path, false);
    } catch (error) {
      if (errno(error) !== 'ENOENT') ask(policy, outside);
    }
  }
  return proof?.path;
}

export async function inspectOutputDirectory(policy: PolicyPaths, path: string, cwd: string): Promise<void> {
  const checked = policy.checks.length;
  const physical = await inspectPath(policy, path, cwd, true);
  if (!physical || policy.checks.length !== checked) return;
  if (protectedAncestor(policy, resolve(cwd, path)) || protectedAncestor(policy, physical)) ask(policy, outside);
  try {
    if ((await stat(physical)).isDirectory()) await inspectDirectoryContents(policy, physical, true);
    else ask(policy);
  } catch (error) {
    if (errno(error) !== 'ENOENT') ask(policy, outside);
  }
}

/** A directory grant covers every path below it, beyond the listed edits. */
export async function inspectGrant(policy: PolicyPaths, root: unknown): Promise<void> {
  if (typeof root !== 'string' || !isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)) {
    ask(policy, outside);
    return;
  }
  const physical = await inspectPath(policy, root, undefined, true);
  const lexical = resolve(root);
  if (!physical || lexical !== physical || !policy.project || !under(physical, policy.project.path)
    || !(await stat(physical).catch(() => null))?.isDirectory()) {
    ask(policy, outside);
    return;
  }
  if (protectedAncestor(policy, lexical)) ask(policy, outside);
  if (!policy.checks.some(check => check.kind === 'deny')) await inspectDirectoryContents(policy, physical, true);
}
