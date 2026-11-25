import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runGit = (cwd: string, args: string[], maxBuffer = 65_536, rawHistory = false) => exec('git', [
  '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
  ...(rawHistory ? ['--no-replace-objects', '-c', 'advice.graftFileDeprecated=false'] : []), '-C', cwd, ...args,
], {
  timeout: 1_500, maxBuffer,
  env: { ...process.env, GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1',
    ...(rawHistory ? { GIT_GRAFT_FILE: '/dev/null' } : {}) },
});
async function git(cwd: string, args: string[], maxBuffer?: number, rawHistory = false): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(cwd, args, maxBuffer, rawHistory);
    return stdout.replace(/\n$/, '');
  } catch {
    return undefined;
  }
}

type GitQuery = { status: 'ok'; stdout: string } | { status: 'unset' } | { status: 'error' };

async function queryGit(cwd: string, args: string[]): Promise<GitQuery> {
  try {
    const { stdout } = await runGit(cwd, args);
    return { status: 'ok', stdout };
  } catch (error) {
    const { code, killed, stderr } = error as { code?: number | string; killed?: boolean; stderr?: string };
    return code === 1 && killed !== true && stderr === '' ? { status: 'unset' } : { status: 'error' };
  }
}

function gitConfig(cwd: string, args: string[]): Promise<GitQuery> {
  return queryGit(cwd, ['config', ...args]);
}

export async function gitRoot(cwd: string): Promise<string | undefined> {
  return repositoryPath(cwd, '--show-toplevel');
}

function repositoryPath(cwd: string, option: string): Promise<string | undefined> {
  return git(cwd, ['rev-parse', '--path-format=absolute', option]).then(path =>
    path && isAbsolute(path) && !/[\n\r\0\uFFFD]/.test(path) ? path : undefined);
}

export async function gitRepository(cwd: string) {
  const [root, gitDir, commonDir] = await Promise.all([
    gitRoot(cwd), repositoryPath(cwd, '--absolute-git-dir'), repositoryPath(cwd, '--git-common-dir'),
  ]);
  let ownerRoot = root;
  if (gitDir && commonDir && (!root || gitDir !== commonDir)) {
    const worktrees = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
    const owner = worktrees?.split('\0', 1)[0]?.match(/^worktree (\/.*)$/s)?.[1];
    ownerRoot = owner && !/[\n\r\uFFFD]/.test(owner) ? owner : undefined;
  }
  return { root, gitDir, commonDir, ownerRoot };
}

interface GitReadOptions {
  flags: string;
  short?: string;
  values?: string;
  input?: string;
  numeric?: boolean;
}

const diffRead = {
  flags: '--patch --no-patch --stat --numstat --shortstat --compact-summary --summary --name-only --name-status'
    + ' --raw --patch-with-raw --patch-with-stat --check --cached --staged --quiet --exit-code --relative --no-relative'
    + ' --no-ext-diff --no-textconv --no-renames --find-renames --find-copies --find-copies-harder --binary'
    + ' --full-index --abbrev --no-abbrev --no-prefix --default-prefix --no-color --color --color-words --word-diff'
    + ' --no-color-moved --color-moved --ignore-space-at-eol --ignore-cr-at-eol --ignore-space-change'
    + ' --ignore-all-space --ignore-blank-lines --ignore-submodules --submodule --no-index --minimal'
    + ' --patience --histogram --reverse --no-indent-heuristic --indent-heuristic',
  short: 'pPsuzwbBRDMCH',
  values: '-U --unified --inter-hunk-context --diff-filter --diff-algorithm --src-prefix --dst-prefix'
    + ' --line-prefix --word-diff-regex --stat-width --stat-name-width --stat-count -S -G --anchored',
  input: '-O',
};

const historyRead = {
  flags: diffRead.flags + ' --oneline --pretty --format --decorate --no-decorate --all'
    + ' --all-match --invert-grep --regexp-ignore-case --basic-regexp --extended-regexp --fixed-strings'
    + ' --graph --reverse --topo-order --date-order --author-date-order --first-parent --no-merges --merges'
    + ' --full-history --simplify-merges --ancestry-path --follow --boundary --left-right --cherry-pick'
    + ' --cherry-mark --parents --children --source --use-mailmap --no-use-mailmap --branches'
    + ' --tags --remotes --glob --walk-reflogs --no-walk --show-notes --no-notes --notes',
  short: diffRead.short + 'qmcf',
  values: diffRead.values + ' -n --max-count --skip --since --after --until --before --author --committer --grep'
    + ' --min-parents --max-parents --date --diff-merges',
  input: diffRead.input,
  numeric: true,
};

const gitReadOptions: Record<string, GitReadOptions> = {
  status: { flags: '--short --branch --show-stash --porcelain --long --verbose --untracked-files'
    + ' --ignored --ignore-submodules --column --no-column --ahead-behind --no-ahead-behind --find-renames'
    + ' --renames --no-renames', short: 'sbzvu' },
  diff: diffRead,
  log: historyRead,
  show: historyRead,
  'rev-parse': { flags: '--verify --quiet --short --revs-only --no-revs --flags --no-flags --symbolic'
    + ' --symbolic-full-name --abbrev-ref --all --branches --tags --remotes --local-env-vars --show-toplevel'
    + ' --show-superproject-working-tree --show-prefix --show-cdup --absolute-git-dir --git-dir --git-common-dir'
    + ' --is-inside-git-dir --is-inside-work-tree --is-bare-repository --is-shallow-repository --show-object-format'
    + ' --show-ref-format --shared-index-path --end-of-options', short: 'q', values: '--path-format --git-path' },
  'ls-files': { flags: '--cached --deleted --modified --others --ignored --stage --unmerged --killed'
    + ' --directory --no-empty-directory --recurse-submodules --exclude-standard --deduplicate --full-name'
    + ' --error-unmatch --abbrev --debug', short: 'cdmoisukvzft',
  values: '-x --exclude --with-tree --format', input: '-X --exclude-from --exclude-per-directory' },
  'ls-tree': { flags: '--long --name-only --name-status --object-only --full-name --full-tree --abbrev',
    short: 'drtlz', values: '--format' },
  describe: { flags: '--all --tags --contains --abbrev --exact-match --debug --always --first-parent --long --dirty --broken',
    values: '--candidates --match --exclude' },
  blame: { flags: '--root --show-stats --progress --no-progress --line-porcelain --porcelain --incremental'
    + ' --show-email --long --show-name --show-number --first-parent --ignore-rev --no-textconv --abbrev --date',
  short: 'bpwlfnseMC', values: '-L --ignore-rev', input: '-S --ignore-revs-file' },
  grep: { flags: '--cached --no-index --untracked --no-exclude-standard --exclude-standard --full-name'
    + ' --text --line-number --column --word-regexp --invert-match --ignore-case --basic-regexp --extended-regexp'
    + ' --fixed-strings --perl-regexp --name-only --files-with-matches --files-without-match --count --quiet --only-matching'
    + ' --null --no-color --color --break --heading --and --or --not --all-match --no-textconv',
  short: 'aiIwvnzlLcoqFEGPhH', values: '-e --regexp -m --max-count -A --after-context -B --before-context'
    + ' -C --context --threads --max-depth', input: '-f --file' },
  shortlog: { flags: '--numbered --summary --email --all --no-merges --merges --group', short: 'nsew',
    values: '--group --since --until --author --committer' },
};

export function gitRead(sub: string, args: string[]): { operands: string[]; paths: string[] } | undefined {
  if (!Object.hasOwn(gitReadOptions, sub)) return;
  const options = gitReadOptions[sub]!;
  const flags = new Set(options.flags.split(' '));
  const values = new Set(options.values?.split(' '));
  const inputs = new Set(options.input?.split(' '));
  const operands: string[] = [];
  const paths: string[] = [];
  let grepPattern = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      operands.push(arg);
      continue;
    }
    if (flags.has(arg)) continue;
    const name = arg.startsWith('--') ? arg.split('=', 1)[0]! : arg.slice(0, 2);
    if (inputs.has(name) || values.has(name)) {
      const value = name === arg ? args[++i] : arg.slice(name.length).replace(/^=/, '');
      if (!value || name === arg && value.startsWith('-')) return;
      if (inputs.has(name)) paths.push(value);
      if (sub === 'grep' && ['-e', '--regexp', '-f', '--file'].includes(name)) grepPattern = true;
    } else if (arg.startsWith(`${name}=`) && flags.has(name)) continue;
    else if (options.numeric && /^-\d+$/.test(arg)) continue;
    else if (sub === 'status' && /^-u(?:no|normal|all)$/.test(arg)) continue;
    else if (['diff', 'log', 'show'].includes(sub) && /^-[MBC]\d+%?$/.test(arg)) continue;
    else if (/^-[^-].*$/.test(arg) && [...arg.slice(1)].every(flag => options.short?.includes(flag))) continue;
    else return;
  }
  return { operands: sub === 'grep' && !grepPattern ? operands.slice(1) : operands, paths };
}

export function isGitRead(sub: string): boolean {
  return Object.hasOwn(gitReadOptions, sub);
}

type GitChange = { kind: 'read' | 'write' | 'destructive'; paths?: string[]; rootRelative?: boolean };
const destructiveChange: GitChange = { kind: 'destructive' };

interface GitOptions {
  flags: Set<string>;
  values: Map<string, string>;
  operands: string[];
  separator: boolean;
}

function parseOptions(
  args: string[], simple: string[], short = '', withValue: string[] = [],
): GitOptions | undefined {
  const result: GitOptions = { flags: new Set(), values: new Map(), operands: [], separator: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      result.operands.push(...args.slice(i + 1));
      result.separator = true;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      result.operands.push(arg);
      continue;
    }
    const option = withValue.find(flag => flag === arg || arg.startsWith(`${flag}=`)
      || flag.length === 2 && arg.startsWith(flag));
    if (option) {
      const value = arg === option ? args[++i] : arg.slice(option.length).replace(/^=/, '');
      if (!value || value.startsWith('-') || result.values.has(option)) return undefined;
      result.values.set(option, value);
    } else if (simple.includes(arg)) {
      result.flags.add(arg);
    } else if (/^-[^-]+$/.test(arg) && [...arg.slice(1)].every(flag => short.includes(flag))) {
      for (const flag of arg.slice(1)) result.flags.add(`-${flag}`);
    } else return undefined;
  }
  return result;
}

function restoreChange(args: string[]): GitChange {
  const options = parseOptions(args, ['--staged', '--no-worktree', '--quiet'], 'Sq', ['-s', '--source']);
  if (!options || !options.flags.has('-S') && !options.flags.has('--staged')) return destructiveChange;
  return { kind: 'write', paths: options.operands };
}

async function checkoutChange(cwd: string, sub: string, args: string[]): Promise<GitChange> {
  const switching = sub === 'switch';
  const creationFlags = switching ? ['-c', '--create'] : ['-b'];
  const options = parseOptions(args, ['--quiet', '--guess', '--no-guess', '--no-overwrite-ignore',
    '--track', '--no-track', '--detach'], 'qtd', creationFlags);
  if (!options || !switching && options.separator || options.values.size > 1 || options.operands.length > 1) return destructiveChange;
  const [target] = options.operands;
  if (options.values.size) {
    const [name] = options.values.values();
    if (await git(cwd, ['check-ref-format', `refs/heads/${name}`]) === undefined) return destructiveChange;
    if (!options.operands.length) return { kind: 'write', paths: [] };
  } else if (!switching && target) {
    // With a sole checkout operand, an existing worktree path can select path checkout.
    try {
      await lstat(`${cwd}/${target}`);
      return destructiveChange;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return destructiveChange;
    }
    if (await git(cwd, ['--literal-pathspecs', 'ls-files', '-z', '--', target]) !== '') return destructiveChange;
  }
  if (!target || /^[-:/]/.test(target)) return destructiveChange;
  try {
    const { stdout, stderr } = await runGit(cwd, ['-c', 'core.warnAmbiguousRefs=true',
      'rev-parse', '--verify', '--end-of-options', `${target}^{commit}`]);
    const commit = stdout.trimEnd();
    if (stderr || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return destructiveChange;
    const changes = await git(cwd, ['diff', '--name-only', '-z', '--no-relative', '--no-renames',
      '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', 'HEAD', commit, '--']);
    if (changes !== undefined && !changes.includes('\uFFFD')) return { kind: 'write', paths: changes.split('\0').filter(Boolean), rootRelative: true };
  } catch {
    // A missing or unresolvable start point needs manual approval.
  }
  return destructiveChange;
}

function branchChange(args: string[]): GitChange {
  const listFlags = ['--list', '--show-current', '--all', '--remotes', '-l', '-a', '-r'];
  const writeFlags = ['--move', '--copy', '--track', '--no-track', '--unset-upstream', '-m', '-c', '-t'];
  const options = parseOptions(args, [...listFlags, ...writeFlags, '--no-color', '--verbose', '--quiet'], 'alrvqmct',
    ['-u', '--set-upstream-to']);
  if (!options) return destructiveChange;
  if (!options.values.size && !writeFlags.some(flag => options.flags.has(flag))
    && (!options.operands.length || listFlags.some(flag => options.flags.has(flag)))) {
    return { kind: 'read' };
  }
  return { kind: 'write' };
}

export async function gitChange(cwd: string, sub: string, args: string[]): Promise<GitChange | undefined> {
  if (sub === 'restore') return restoreChange(args);
  if (sub === 'checkout' || sub === 'switch') return checkoutChange(cwd, sub, args);
  if (sub === 'branch') return branchChange(args);
  if (sub === 'merge') return destructiveChange;
}

async function defaultRemote(cwd: string, names: string[]): Promise<string | undefined> {
  const result = await queryGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  if (result.status === 'error') return undefined;
  const ref = result.status === 'ok' ? result.stdout.replace(/\n$/, '') : undefined;
  if (ref !== undefined && !ref.startsWith('refs/heads/')) return undefined;
  const branch = ref?.slice('refs/heads/'.length);
  const keys = [
    ...(branch ? [`branch.${branch}.pushRemote`] : []),
    'remote.pushDefault',
    ...(branch ? [`branch.${branch}.remote`] : []),
  ];
  for (const key of keys) {
    const value = await gitConfig(cwd, ['--get', key]);
    if (value.status === 'error') return undefined;
    if (value.status === 'ok') return value.stdout.replace(/\n$/, '');
  }
  return names.length === 1 ? names[0]! : 'origin';
}

function githubRepository(value: string): { owner: string; repository: string } | null {
  const url = /^(?:https?:\/\/github\.com(?::443)?\/|ssh:\/\/(?:git@)?(?:github\.com(?::22)?|ssh\.github\.com:443)\/|(?:git@)?github\.com:)([\w.-]+)\/([\w.-]+)\/?$/i.exec(value);
  return url ? { owner: url[1]!.toLowerCase(), repository: url[2]!.replace(/\.git$/i, '').toLowerCase() } : null;
}

async function rewritePushUrl(cwd: string, url: string): Promise<string[] | undefined> {
  const result = await gitConfig(cwd, ['--null', '--get-regexp', '^url\\..*\\.(pushinsteadof|insteadof)$']);
  if (result.status === 'error') return undefined;
  if (result.status === 'unset') return [url];
  const entries = result.stdout.split('\0');
  const rules = entries.flatMap(entry => {
    const match = /^url\.(.+)\.(pushinsteadof|insteadof)\n([^\n]*)$/s.exec(entry);
    if (!match || !match[3] || !url.startsWith(match[3])) return [];
    return [{ base: match[1]!, push: match[2] === 'pushinsteadof', prefix: match[3] }];
  });
  const candidates = rules.some(rule => rule.push) ? rules.filter(rule => rule.push) : rules;
  if (!candidates.length) return [url];
  const longest = Math.max(...candidates.map(rule => rule.prefix.length));
  return [...new Set(candidates.filter(rule => rule.prefix.length === longest).map(rule => rule.base + url.slice(longest)))];
}

export interface GitPushFacts {
  resolved: boolean;
  ownGitHub: boolean;
  projtool: boolean;
  risky: boolean;
  reviews: boolean;
}

async function pushSources(cwd: string, refspecs: string[]): Promise<{
  commits: string[];
  incomplete: boolean;
}> {
  const sources = new Set<string>();
  let incomplete = false;
  for (let i = 0; i < refspecs.length; i++) {
    const spec = refspecs[i]!.replace(/^\+/, '');
    if (spec === 'tag') {
      const tag = refspecs[++i];
      if (tag) sources.add(`refs/tags/${tag}`);
      else incomplete = true;
      continue;
    }
    const separator = spec.lastIndexOf(':');
    const source = separator < 0 ? spec : spec.slice(0, separator);
    if (source && !source.includes('*')) sources.add(source);
  }
  const commits = new Set<string>();
  if (sources.size > 1024) incomplete = true;
  const deadline = Date.now() + 1_500;
  for (const source of [...sources].slice(0, 1024)) {
    if (Date.now() >= deadline) {
      incomplete = true;
      break;
    }
    try {
      const { stdout, stderr } = await runGit(cwd, ['-c', 'core.warnAmbiguousRefs=true',
        'rev-parse', '--verify', '--end-of-options', `${source}^{commit}`], undefined, true);
      const commit = stdout.trimEnd();
      if (stderr || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) incomplete = true;
      else commits.add(commit);
    } catch {
      incomplete = true;
    }
  }
  return { commits: [...commits], incomplete };
}

export async function gitPushFacts(cwd: string, args: string[], reviewPaths: string[] = []): Promise<GitPushFacts> {
  const safeFlags = new Set(['-u', '--set-upstream', '--porcelain', '-q', '--quiet', '-v', '--verbose',
    '--dry-run', '--progress', '--no-progress', '--atomic']);
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
  let risky = false;
  let bulk = false;
  let deleting = false;
  let namedTarget: string | undefined;
  const operands: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') options = false;
    else if (options && arg.startsWith('-')) {
      if (safeFlags.has(arg)) continue;
      risky = true;
      bulk ||= ['--all', '--branches', '--tags', '--mirror'].includes(arg);
      if (arg === '--delete' || arg === '-d') deleting = true;
      const [name] = arg.split('=', 1);
      if (name && valueOptions.has(name)) {
        const value = arg === name ? args[++i] : arg.slice(name.length + 1);
        if (name === '--repo') namedTarget = value;
      }
    } else operands.push(arg);
  }
  const [target, ...refspecs] = namedTarget ? [namedTarget, ...operands] : operands;
  risky ||= refspecs.some(spec => /^[+:]|\*/.test(spec));
  const remotes = await git(cwd, ['remote']);
  risky ||= remotes === undefined;
  const names = remotes?.split('\n').filter(Boolean) ?? [];
  const remote = target ?? await defaultRemote(cwd, names);
  let urls: string[] = [];
  if (remote && names.includes(remote)) {
    const [pushUrls, configuredSpecs, mirror] = await Promise.all([
      git(cwd, ['remote', 'get-url', '--push', '--all', '--', remote]),
      gitConfig(cwd, ['--null', '--get-all', `remote.${remote}.push`]),
      gitConfig(cwd, ['--type=bool', '--get', `remote.${remote}.mirror`]),
    ]);
    risky ||= pushUrls === undefined || configuredSpecs.status === 'error' || mirror.status === 'error';
    urls = pushUrls?.split('\n').filter(Boolean) ?? [];
    if (mirror.status === 'ok' && mirror.stdout === 'true\n') {
      risky = true;
      bulk = true;
    }
    if (!refspecs.length && configuredSpecs.status === 'ok') {
      refspecs.push(...configuredSpecs.stdout.split('\0').filter(Boolean));
      risky ||= refspecs.some(spec => /^[+:]|\*/.test(spec));
    }
  } else if (target) {
    const rewritten = await rewritePushUrl(cwd, target);
    risky ||= rewritten === undefined;
    urls = rewritten ?? [];
  }
  if (!refspecs.length && !bulk && !deleting) {
    const pushDefault = await gitConfig(cwd, ['--get', 'push.default']);
    const mode = pushDefault.status === 'ok' ? pushDefault.stdout.trimEnd() : 'simple';
    if (pushDefault.status === 'error' || !['simple', 'current', 'upstream'].includes(mode)) risky = true;
    if (!['matching', 'nothing'].includes(mode)) refspecs.push('HEAD');
  }
  let reviews = false;
  const sources = await pushSources(cwd, deleting ? [] : refspecs);
  risky ||= sources.incomplete;
  if (reviewPaths.length) {
    const [history, shallow] = await Promise.all([
      git(cwd, ['rev-list', '--all', '--full-history', '--max-count=1', ...sources.commits,
        '--', ...reviewPaths.map(path => `:(top,literal)${path}`)], undefined, true),
      git(cwd, ['rev-parse', '--is-shallow-repository']),
    ]);
    // A failed history walk can still identify restricted paths in the current tree.
    reviews = Boolean(history ?? await git(cwd, [
      '--literal-pathspecs', 'ls-tree', '--full-tree', '-z', 'HEAD', '--', ...reviewPaths,
    ], undefined, true));
    risky ||= history === undefined || shallow !== 'false';
  }
  const repositories = urls.map(githubRepository);
  return {
    resolved: repositories.length > 0,
    ownGitHub: repositories.length > 0 && repositories.every(repo => repo?.owner === 'phylipppp-zzy'),
    projtool: repositories.some(repo => repo?.repository === 'projtool') || Boolean(remote && githubRepository(remote)?.repository === 'projtool'),
    risky,
    reviews,
  };
}
