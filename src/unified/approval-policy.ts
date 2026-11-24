import { opendir, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { ask, destructive, inspectGrant, inspectPath, makePolicy, outside, provePath, systemChange, under, unknown, type ApprovalContext, type Check, type PolicyPaths } from './approval-policy-paths.js';
import { gitChange, gitPushFacts, gitRead, gitRepository, isGitRead } from './approval-policy-git.js';
import { buildPrograms, inspectBuild, inspectGitCommit, inspectLocalNodeModule, inspectPackageScripts, inspectReadOnly, inspectSearch, readOnlyOptions } from './approval-policy-options.js';
import { parseShellCommands, type ShellCommand, type ShellOperator } from './approval-policy-shell.js';

export type { ApprovalContext, ApprovalScope } from './approval-policy-paths.js';
export type GateDecision =
  | { kind: 'allow_once' }
  | { kind: 'ask'; reason: string }
  | { kind: 'question' }
  | { kind: 'deny'; reason: string };
export type ApprovalRequest =
  | { kind: 'command'; command?: string }
  | { kind: 'read' | 'write'; paths?: readonly string[] }
  | { kind: 'question' }
  | { kind: 'unknown' };
export type ApprovalFacts = { question: boolean; checks: readonly Check[] };

const externalAction = '公开发布、联系他人、计费或变更远端资源需人工审批';

const smallCommands = new Set(['echo', 'printf', 'true', 'false', 'pwd']);
const mutationOptions: Record<string, { simple: RegExp; values?: string[] }> = {
  mkdir: { simple: /^(?:-[pv]+|--parents|--verbose)$/, values: ['-m', '--mode'] },
  touch: { simple: /^(?:-[acm]+|--no-create)$/, values: ['-d', '--date', '-r', '--reference', '-t'] },
  rm: { simple: /^(?:-[frRivd]+|--force|--recursive|--interactive|--verbose|--dir|--one-file-system)$/ },
  rmdir: { simple: /^(?:-[v]+|--verbose|--ignore-fail-on-non-empty)$/ },
  mv: { simple: /^(?:-[fintv]+|--force|--no-clobber|--interactive|--verbose|--no-target-directory)$/, values: ['-t', '--target-directory'] },
  cp: { simple: /^(?:-[finvT]+|--force|--no-clobber|--interactive|--verbose|--no-target-directory)$/, values: ['-t', '--target-directory'] },
  tee: { simple: /^(?:-[ai]+|--append|--ignore-interrupts)$/ },
  ln: { simple: /^(?:-[sfTvn]+|--symbolic|--force|--verbose|--no-target-directory)$/, values: ['-t', '--target-directory'] },
  truncate: { simple: /^(?:-c|--no-create)$/, values: ['-s', '--size', '-r', '--reference'] },
};
const privileged = new Set(['sudo', 'su', 'pkexec', 'passwd', 'visudo', 'systemctl', 'service', 'ufw', 'iptables', 'ip6tables', 'nft', 'ip', 'nmcli', 'resolvectl', 'chown', 'chmod', 'mount', 'umount', 'ssh', 'scp', 'sftp']);
const external = new Set(['ros', 'autodl', 'aws', 'gcloud', 'az', 'terraform', 'kubectl', 'rsync', 'mail', 'mailx', 'sendmail', 'twine', 'curl', 'wget', 'pip', 'pip3', 'docker']);
const writeGit = new Set(['add', 'commit', 'fetch', 'worktree']);
const reviewUpload = 'AGENTS.md 禁止上传 reviews/ 中的保密盲审材料';

function positional(args: string[], usesValue = new Set<string>()): string[] {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return [...result, ...args.slice(i + 1)];
    if (usesValue.has(arg)) i++;
    else if (!arg.startsWith('-') || arg === '-') result.push(arg);
  }
  return result;
}

async function inspectGit(policy: PolicyPaths, logical: string, args: string[], cwd: string, gitStateChanged: boolean): Promise<boolean> {
  let logicalCwd = logical;
  let i = 0;
  while (args[i]?.startsWith('-')) {
    const opt = args[i++]!;
    if (opt === '--no-pager' || opt === '-P') continue;
    if (opt !== '-C' || args[i] === undefined) {
      ask(policy, systemChange);
      return false;
    }
    const target = args[i++]!;
    if (!target) continue;
    logicalCwd = resolve(logicalCwd, target);
    const path = await inspectPath(policy, target, cwd, false);
    if (!path) return false;
    cwd = path;
  }
  const sub = args[i] ?? '';
  const flags = args.slice(i + 1);
  if (sub === 'stash') {
    ask(policy, destructive);
    return false;
  }
  if (isGitRead(sub)) {
    const read = gitRead(sub, flags);
    if (!read) {
      const output = optionValue(flags, '--output');
      if (output) await inspectPath(policy, output, cwd, true);
      ask(policy);
      return false;
    }
    await inspectPaths(policy, [...read.paths, ...read.operands.filter(arg => arg.includes('/'))], cwd, false);
    return true;
  }
  if (sub === 'worktree' && flags[0] === 'list' && flags.slice(1).every(arg => ['--porcelain', '-z', '-v', '--verbose'].includes(arg))) return true;
  const change = await gitChange(cwd, sub, flags);
  if (change?.kind === 'read') {
    await inspectPaths(policy, change.paths ?? flags.filter(arg => !arg.startsWith('-') && arg.includes('/')), cwd, false);
    return true;
  }
  const { root, gitDir, commonDir, ownerRoot } = await gitRepository(cwd);
  const repoRoots = new Set([root, ownerRoot].filter((path): path is string => Boolean(path)));
  const repoLocations = new Set<string>(repoRoots);
  for (const repoRoot of repoRoots) {
    const physical = await inspectPath(policy, repoRoot, undefined, true);
    if (physical) repoLocations.add(physical);
  }
  if (!ownerRoot) ask(policy, outside);
  const metadataLocations = new Set<string>();
  for (const metadata of new Set([gitDir, commonDir])) {
    if (!metadata) {
      ask(policy, outside);
      continue;
    }
    metadataLocations.add(metadata);
    const physical = await inspectPath(policy, metadata, undefined, true, false, true);
    if (physical) metadataLocations.add(physical);
    if (!physical || !(await stat(physical).catch(() => null))?.isDirectory()) ask(policy, outside);
  }
  if (gitStateChanged) ask(policy);
  if (sub === 'push') {
    const reviews = join(policy.home, 'reviews');
    const physicalReviews = await provePath(reviews);
    const reviewRoots = [reviews, physicalReviews?.path];
    if ([logicalCwd, cwd, ...repoLocations, ...metadataLocations].some(
      path => reviewRoots.some(reviewRoot => reviewRoot && under(resolve(path), reviewRoot)),
    )) {
      policy.checks.push({ kind: 'deny', reason: reviewUpload });
      return false;
    }
    const reviewPaths = new Set<string>();
    for (const location of repoLocations) {
      for (const reviewRoot of reviewRoots) {
        if (reviewRoot && under(reviewRoot, location)) reviewPaths.add(relative(location, reviewRoot));
      }
    }
    const facts = await gitPushFacts(cwd, flags, [...reviewPaths]);
    if (facts.reviews) policy.checks.push({ kind: 'deny', reason: reviewUpload });
    else if (facts.projtool) policy.checks.push({ kind: 'deny', reason: 'AGENTS.md 禁止向 projtool 仓库执行 git push' });
    else if (facts.risky) ask(policy, destructive);
    else if (!facts.resolved || !facts.ownGitHub) ask(policy, '未确认推送目标为本人 GitHub 仓库，需人工审批');
    return false;
  }
  if (flags.some(arg => /^--(?:exec|ext-diff|upload-pack|receive-pack|exec-path)(?:=|$)|^ext::/.test(arg))) {
    ask(policy, systemChange);
    return false;
  }
  if ((!change && !writeGit.has(sub)) || sub === 'worktree' && flags[0] !== 'add') {
    ask(policy, sub === 'clean' || sub === 'reset' ? destructive : undefined);
    return false;
  }
  if (!root) {
    await inspectPath(policy, cwd, cwd, true);
    ask(policy);
  }
  if (change?.kind === 'destructive' || !change && flags.some(arg => /^(?:--discard-changes|--force|-f|-D|--edit-description)$/.test(arg))) {
    ask(policy, destructive);
  }
  if (sub === 'commit') {
    if (flags.includes('--amend')) ask(policy, destructive);
    await inspectGitCommit(policy, cwd, flags);
  }
  if (!change && optionValue(flags, '--pathspec-from-file')) ask(policy);
  if (change?.paths) {
    if (!change.rootRelative && change.paths.some(path => path.startsWith(':') || /[*?[\\]/.test(path))) ask(policy);
    const paths = change.paths.map(path => change.rootRelative ? `./${path}` : path === '-' ? './-' : path);
    await inspectPaths(policy, paths, change.rootRelative ? root ?? cwd : cwd, true);
  } else if (sub === 'worktree' && flags[0] === 'add') {
    await inspectPaths(policy, positional(flags.slice(1), new Set(['-b', '-B'])).slice(0, 1), cwd, true);
  } else if (['add', 'checkout', 'restore'].includes(sub)) {
    const split = flags.indexOf('--');
    const paths = split >= 0 ? flags.slice(split + 1) : positional(flags, new Set(['-m', '--message', '-b', '-B', '-s', '--source']));
    await inspectPaths(policy, paths, cwd, true);
  }
  return false;
}

async function inspectPaths(policy: PolicyPaths, paths: readonly string[], cwd: string | undefined, write: boolean, remove = false): Promise<void> {
  for (const path of paths) if (path !== '-') await inspectPath(policy, path, cwd, write, remove);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const arg = args[index]!;
  return arg === name ? args[index + 1] : arg.slice(name.length + 1);
}

const simpleNodeTestOptions = new Set(['--test-only', '--test-force-exit', '--test-update-snapshots']);
const valuedNodeTestOptions = new Set([
  '--test-concurrency', '--test-name-pattern', '--test-skip-pattern', '--test-shard', '--test-timeout',
]);

async function inspectNodeTestGlob(policy: PolicyPaths, cwd: string, pattern: string): Promise<void> {
  const match = /^((?:[a-z0-9_][a-z0-9_.-]*\/)+)\*(\.[a-z0-9_.-]+)$/i.exec(pattern);
  if (!match) { ask(policy); return; }
  const directory = match[1]!;
  const suffix = match[2]!;
  const checked = policy.checks.length;
  const physical = await inspectPath(policy, directory, cwd, false);
  if (!physical || policy.checks.length !== checked) return;
  try {
    let examined = 0;
    let matched = false;
    for await (const entry of await opendir(physical)) {
      if (++examined > 1024) { ask(policy); return; }
      if (entry.name.startsWith('.') || !entry.name.endsWith(suffix)) continue;
      matched = true;
      const path = await inspectPath(policy, directory + entry.name, cwd, false);
      if (!path || !(await stat(path).catch(() => null))?.isFile()) ask(policy);
    }
    if (!matched) ask(policy);
  } catch {
    ask(policy);
  }
}

async function inspectNode(policy: PolicyPaths, cwd: string, args: string[], globs: readonly number[] = []): Promise<boolean> {
  let mode: 'check' | 'test' | undefined;
  let testOptions = false;
  let tsx = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg === '--test' || arg === '--check' || arg === '-c') {
      if (mode) { ask(policy); return false; }
      mode = arg === '--test' ? 'test' : 'check';
    } else if (simpleNodeTestOptions.has(arg)) {
      testOptions = true;
    } else if (arg === '--import' || arg === '--import=tsx') {
      const name = arg === '--import' ? args[++i] : 'tsx';
      if (name !== 'tsx' || tsx) { ask(policy); return false; }
      tsx = true;
    } else if (valuedNodeTestOptions.has(arg.split('=', 1)[0]!)) {
      const separator = arg.indexOf('=');
      const value = separator >= 0 ? arg.slice(separator + 1) : args[++i];
      if (!value || value.startsWith('-')) { ask(policy); return false; }
      testOptions = true;
    } else { ask(policy); return false; }
  }
  const files = args.slice(i);
  if (!mode || files.some(file => file.startsWith('-')) || globs.some(index => index < i)
    || mode === 'check' && (files.length !== 1 || testOptions || tsx || globs.length)) {
    ask(policy);
    return false;
  }
  if (process.env.NODE_OPTIONS || tsx && !await inspectLocalNodeModule(policy, cwd, 'tsx')) ask(policy);
  for (const [index, file] of files.entries()) {
    if (globs.includes(i + index)) await inspectNodeTestGlob(policy, cwd, file);
    else if (mode === 'test' && /[*?[\]{}]/.test(file)) ask(policy);
    else if (file !== '-') await inspectPath(policy, file, cwd, false);
  }
  if (mode === 'test') await inspectPath(policy, cwd, cwd, true);
  return mode === 'check';
}

async function inspectPython(policy: PolicyPaths, cwd: string, args: string[]): Promise<boolean> {
  const [first, second, ...rest] = args;
  if (first === '-m' && second === 'pytest') {
    await inspectBuild(policy, cwd, second, rest);
    return false;
  }
  if (first === '-m' && ['py_compile', 'unittest'].includes(second ?? '')) {
    await inspectPaths(policy, positional(rest), cwd, second === 'py_compile');
    if (second !== 'py_compile') await inspectPath(policy, cwd, cwd, true);
    return false;
  }
  if (first === '-c') {
    if (second && /^\s*print\(\s*(?:-?\d+(?:\.\d+)?|(["'])(?:[^"'\\\n])*\1)\s*\)\s*$/.test(second)) return true;
    const pathExpression = second && /^\s*from pathlib import Path\s*;\s*print\(Path\((["'])([^"'\\\n]+)\1\)\.(?:read_text|read_bytes|exists|is_file|is_dir|stat|resolve)\(\)\)\s*$/.exec(second);
    if (pathExpression) await inspectPath(policy, pathExpression[2]!, cwd, false);
    else ask(policy);
    return !!pathExpression;
  }
  if (first && !first.startsWith('-') && policy.pmCheck) {
    const script = await provePath(first, cwd);
    if (!script || script.unresolvedLink || script.path !== policy.pmCheck
      || args.length < 2 || args.slice(1).some(path => path.startsWith('-'))) {
      ask(policy);
      return false;
    }
    await inspectPaths(policy, args.slice(1), cwd, false);
    return true;
  }
  ask(policy);
  return false;
}

async function inspectUniq(policy: PolicyPaths, cwd: string, args: string[]): Promise<boolean> {
  const operands: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') options = false;
    else if (!options || !arg.startsWith('-') || arg === '-') operands.push(arg);
    else if (/^--(?:count|repeated|ignore-case|unique|zero-terminated|help|version)$/.test(arg)
      || /^--(?:all-repeated|group)(?:=(?:none|prepend|separate|append|both))?$/.test(arg)) continue;
    else if (/^--(?:skip-fields|skip-chars|check-chars)(?:=|$)/.test(arg) || /^-[cdDiuz]*[fsw]/.test(arg)) {
      const separator = arg.indexOf('=');
      const attached = arg.startsWith('--')
        ? (separator < 0 ? undefined : arg.slice(separator + 1))
        : arg.replace(/^-[cdDiuz]*[fsw]/, '') || undefined;
      const value = attached ?? args[++i];
      if (!value || !/^\d+$/.test(value)) { ask(policy); return false; }
    } else if (!/^-[cdDiuz]+$/.test(arg)) { ask(policy); return false; }
  }
  if (operands.length > 2) { ask(policy); return false; }
  const [input, output] = operands;
  if (input && input !== '-') await inspectPath(policy, input, cwd, false);
  if (output && output !== '-') await inspectPath(policy, output, cwd, true);
  return !output || output === '-';
}

async function inspectSort(policy: PolicyPaths, cwd: string, args: string[]): Promise<boolean> {
  const locations = new Map([
    ['-o', true], ['--output', true], ['-T', true], ['--temporary-directory', true], ['--random-source', false],
  ]);
  let read = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      await inspectPaths(policy, args.slice(i + 1), cwd, false);
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      await inspectPaths(policy, [arg], cwd, false);
      continue;
    }
    if (/^--(?:compress-program|files0-from)(?:=|$)/.test(arg)) ask(policy);
    else if (/^--(?:help|version|ignore-leading-blanks|dictionary-order|fold-case|general-numeric-sort|ignore-nonprinting|human-numeric-sort|month-sort|numeric-sort|random-sort|reverse|version-sort|merge|stable|unique|zero-terminated|debug)$/.test(arg)
      || /^--check(?:=(?:diagnose-first|quiet|silent))?$/.test(arg) || /^-[bdfghiMhnRrVmcsCuz]+$/.test(arg)) continue;
    else {
      const option = arg.startsWith('--') ? arg.split('=', 1)[0]! : arg.match(/^-[bdfghiMhnRrVmcsCuz]*([oTktS])/)?.[1]?.padStart(2, '-');
      if (!option || !(locations.has(option) || ['-k', '-t', '-S', '--key', '--field-separator', '--buffer-size', '--parallel', '--batch-size', '--sort'].includes(option))) {
        ask(policy);
        continue;
      }
      const attached = option.startsWith('--') ? arg.slice(option.length + 1) : arg.slice(arg.indexOf(option[1]!) + 1);
      const value = attached || (arg.includes('=') && option.startsWith('--') ? '' : args[++i]);
      if (!value) ask(policy);
      else if (locations.has(option)) {
        const write = locations.get(option)!;
        await inspectPath(policy, value, cwd, write);
        read &&= !write;
      }
    }
  }
  return read;
}

async function inspectMutation(policy: PolicyPaths, cwd: string, program: string, args: string[], { simple, values = [] }: typeof mutationOptions[string]): Promise<void> {
  const paths: string[] = [];
  let destination: string | undefined;
  let options = true;
  if (program === 'ln') ask(policy);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') options = false;
    else if (options && arg.startsWith('-') && arg !== '-') {
      const name = values.find(option => arg === option || arg.startsWith(`${option}=`) || option.length === 2 && arg.startsWith(option));
      if (name) {
        const value = arg === name ? args[++i] : arg.slice(name.length).replace(/^=/, '');
        if (!value) ask(policy);
        else if (['-r', '--reference'].includes(name)) await inspectPath(policy, value, cwd, false);
        else if (name === '--target-directory' || name === '-t' && program !== 'touch') destination = value;
      } else if (!simple.test(arg)) ask(policy);
    } else paths.push(arg);
  }
  if (!paths.length) ask(policy);
  if (['cp', 'mv', 'ln'].includes(program)) {
    const to = destination ?? (paths.length > 1 ? paths.pop() : undefined);
    if (!to) {
      ask(policy);
      return;
    }
    const proof = await inspectPath(policy, to, cwd, true);
    const toDirectory = destination || proof && (await stat(proof).catch(() => null))?.isDirectory();
    for (const from of paths) {
      await inspectPath(policy, from, cwd, program === 'mv', program === 'mv');
      if (toDirectory) await inspectPath(policy, `${to}/${posix.basename(from)}`, cwd, true);
    }
  } else await inspectPaths(policy, paths, cwd, true, ['rm', 'rmdir'].includes(program));
}

async function inspectCommand(
  policy: PolicyPaths, cwd: string, program: string, args: string[], physicalCwd: string, gitStateChanged: boolean,
  scriptDepth: number, globs: readonly number[] = [],
): Promise<boolean> {
  if (globs.length && (program !== 'node' || globs.includes(0))) {
    ask(policy);
    return false;
  }
  if (smallCommands.has(program)) {
    const writes = program === 'printf' && args.some(arg => arg === '-v' || /^-v\w/.test(arg) || /%[^%\s]*n/.test(arg));
    if (writes) ask(policy);
    return !writes;
  }
  const readOptions = Object.hasOwn(readOnlyOptions, program) ? readOnlyOptions[program] : undefined;
  if (privileged.has(program) || /^(?:gh|gcloud|npm|docker)$/.test(program) && ['auth', 'login', 'logout'].includes(args[0] ?? '')) {
    ask(policy, systemChange);
  } else if (external.has(program) || program === 'gh') {
    ask(policy, externalAction);
  } else if (program === 'git') {
    return inspectGit(policy, cwd, args, physicalCwd, gitStateChanged);
  } else if (Object.hasOwn(mutationOptions, program)) {
    await inspectMutation(policy, cwd, program, args, mutationOptions[program]!);
  } else if (program === 'uniq') {
    return inspectUniq(policy, cwd, args);
  } else if (program === 'sort') {
    return inspectSort(policy, cwd, args);
  } else if (readOptions) {
    await inspectReadOnly(policy, cwd, args, readOptions);
    return true;
  } else if (program === 'find') {
    const followLinks = args[0] === '-L';
    const operands = ['-P', '-H', '-L'].includes(args[0] ?? '') ? args.slice(1) : args;
    const expression = operands.findIndex(arg => arg.startsWith('-') || arg === '!');
    const predicates = expression < 0 ? [] : operands.slice(expression);
    if (followLinks) ask(policy, outside);
    const writes = predicates.some(arg => /^-(?:exec|ok|delete|fls|fprint|fprintf)/.test(arg));
    if (writes) ask(policy);
    await inspectPaths(policy, expression < 0 ? operands : operands.slice(0, expression), cwd, false);
    return !writes;
  } else if (program === 'rg' || program === 'grep') {
    await inspectSearch(policy, cwd, program, args);
    return true;
  } else if (program === 'sed') {
    const modify = args[0] === '-i' || args[0] === '--in-place';
    const [script, ...files] = modify || args[0] === '-n' ? args.slice(1) : args;
    const printRange = script && /^\d+(?:,\d+)?p$/.test(script);
    const simpleSubstitution = script && /^(?:\d+(?:,\d+)?)?s\/(?:[^\/\\\n]|\\.)*\/(?:[^\/\\\n]|\\.)*\/[gIp0-9]*$/.test(script);
    if (!script || !(modify ? simpleSubstitution : printRange || simpleSubstitution) || files.some(arg => arg.startsWith('-'))) ask(policy);
    await inspectPaths(policy, files, cwd, modify);
    return !modify;
  } else if (/^python(?:3(?:\.\d+)?)?$/.test(program)) {
    return inspectPython(policy, cwd, args);
  } else if (program === 'node' || ['npx', 'pnpm', 'yarn'].includes(program) && args[0] === 'tsx') {
    if (program !== 'node' && !await inspectLocalNodeModule(policy, cwd, 'tsx', true)) ask(policy);
    const read = await inspectNode(policy, cwd, program === 'node' ? args : args.slice(1), globs.map(index => index - 1));
    return program === 'node' && read;
  } else if (buildPrograms.has(program)) {
    let lifecycleGitStateChanged = gitStateChanged;
    const script = await inspectPackageScripts(policy, cwd, program, args, async source => {
      const commands = scriptDepth < 2 ? parseShellCommands(source, true) : null;
      if (!commands) {
        ask(policy);
        lifecycleGitStateChanged = true;
      } else {
        lifecycleGitStateChanged = await inspectShell(policy, cwd, commands, scriptDepth + 1, lifecycleGitStateChanged);
      }
    });
    if (script) return false;
    if (!await inspectBuild(policy, cwd, program, args)) {
      ask(policy, /(?:publish|deploy|release|login|start|exec|install|unlink)/.test(args.slice(0, 2).join(' ')) ? externalAction : unknown);
    }
  } else {
    ask(policy);
  }
  return false;
}

type ShellLocation = { logical: string; physical: string };

async function inspectCd(policy: PolicyPaths, cwd: ShellLocation, args: string[]): Promise<ShellLocation | undefined> {
  const operand = args[0] === '--' ? args[1] : args[0];
  if (!operand || args.length !== (args[0] === '--' ? 2 : 1) || operand.startsWith('-')
    || process.env.CDPATH && !isAbsolute(operand) && !/^\.\.?($|\/)/.test(operand)) {
    ask(policy);
    return;
  }
  const logical = resolve(cwd.logical, operand);
  const physical = await inspectPath(policy, logical, undefined, false);
  const traversal = await provePath(operand, cwd.physical);
  if (logical !== physical || traversal?.path !== physical || traversal?.unresolvedLink) ask(policy, outside);
  if (!physical || !(await stat(physical).catch(() => null))?.isDirectory()) {
    ask(policy, outside);
    return;
  }
  return { logical, physical };
}

async function inspectShell(
  policy: PolicyPaths, cwd: string, commands: ShellCommand[], scriptDepth = 0, gitStateChanged = false,
): Promise<boolean> {
  type PossibleResult = { cwd: ShellLocation; success: boolean };
  const logical = resolve(cwd);
  const physical = await inspectPath(policy, cwd, undefined, false);
  if (!physical) return true;
  if (logical !== physical || !(await stat(physical).catch(() => null))?.isDirectory()) ask(policy, outside);
  let states: PossibleResult[] = [{ cwd: { logical, physical }, success: true }];
  let connector: ShellOperator | undefined;
  for (let i = 0; i < commands.length;) {
    const start = i;
    while (commands[i]?.next === '|') i++;
    const group = commands.slice(start, ++i);
    let changedByGroup = false;
    const resulting = new Map<string, PossibleResult>();
    const executions = new Map<string, ShellLocation>();
    const remember = (location: ShellLocation, success: boolean) => {
      resulting.set(JSON.stringify([location.logical, location.physical, success]), { cwd: location, success });
    };
    for (const state of states) {
      if (connector === '&&' && !state.success || connector === '||' && state.success) {
        remember(state.cwd, state.success);
        continue;
      }
      const key = JSON.stringify(state.cwd);
      let successPath = executions.get(key);
      if (!successPath) {
        successPath = state.cwd;
        let changed: boolean = gitStateChanged;
        for (const command of group) {
          for (const redirect of command.redirects) await inspectPath(policy, redirect.path, state.cwd.logical, redirect.write);
          const [program, ...args] = command.words;
          if (program === 'cd') {
            const path = command.globs?.length ? undefined : await inspectCd(policy, state.cwd, args);
            if (command.globs?.length) ask(policy);
            if (group.length === 1 && path) successPath = path;
          } else if (program) {
            const read = await inspectCommand(policy, state.cwd.logical, program, args, state.cwd.physical, changed,
              scriptDepth, command.globs);
            changed ||= !read;
          }
          changed ||= command.redirects.some(redirect => redirect.write);
        }
        changedByGroup ||= changed;
        executions.set(key, successPath);
      }
      remember(successPath, true);
      remember(state.cwd, false);
    }
    gitStateChanged ||= changedByGroup;
    connector = group.at(-1)?.next;
    states = [...resulting.values()];
    if (states.length > 16) {
      ask(policy);
      return true;
    }
  }
  return gitStateChanged;
}

export async function resolveApprovalFacts(request: ApprovalRequest, context: ApprovalContext): Promise<ApprovalFacts> {
  const checks: Check[] = [];
  if (request.kind === 'question') return { question: true, checks };
  if (context.enabled === false) return { question: false, checks: [policyDisabled] };
  const base = context.cwd ?? context.project;
  const cwd = base && isAbsolute(base) ? base : undefined;
  const policy = await makePolicy(context, checks);
  if (request.kind === 'read' || request.kind === 'write') {
    if (!request.paths?.length || request.paths.length > 256) ask(policy);
    else for (const path of request.paths) await inspectPath(policy, path, cwd, request.kind === 'write');
    return { question: false, checks };
  }
  const commands = request.kind === 'command' && request.command ? parseShellCommands(request.command) : null;
  if (!commands || !cwd) {
    ask(policy);
    return { question: false, checks };
  }
  await inspectShell(policy, cwd, commands);
  return { question: false, checks };
}

const policyDisabled = { kind: 'ask', reason: '部署配置已停用自动审批，需人工审批' } as const;

export async function evaluateApprovalGrant(root: unknown, context: ApprovalContext): Promise<GateDecision> {
  if (context.enabled === false) return policyDisabled;
  const policy = await makePolicy(context);
  await inspectGrant(policy, root);
  const denied = policy.checks.find(check => check.kind === 'deny');
  if (denied) return denied;
  return policy.checks.length
    ? { kind: 'ask', reason: `无法自动批准目录授权：${policy.checks[0]!.reason}` }
    : { kind: 'allow_once' };
}

export function evaluateApproval(facts: ApprovalFacts): GateDecision {
  if (facts.question) return { kind: 'question' };
  return facts.checks.find(check => check.kind === 'deny')
    ?? facts.checks.find(check => check.reason !== unknown && check.reason !== outside)
    ?? facts.checks[0] ?? { kind: 'allow_once' };
}
