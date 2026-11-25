import { constants } from 'node:fs';
import { access, lstat, open, stat } from 'node:fs/promises';
import { join, posix, relative, resolve } from 'node:path';
import { ask, inspectOutputDirectory, inspectPath, under, type PolicyPaths } from './approval-policy-paths.js';

interface Options {
  flags: RegExp;
  values?: readonly string[];
  read?: readonly string[];
  write?: readonly string[];
  readableFiles?: boolean;
  compactShort?: boolean;
  shortEquals?: boolean;
  outputRoot?: (name: string, value: string) => string | undefined;
  validValue?: (name: string, value: string) => boolean;
  onFlag?: (flag: string) => void;
  onValue?: (name: string, value: string) => void;
}

function valueOption(arg: string, spec: Options): [name: string, attached: string | undefined] | undefined {
  const names = [...(spec.values ?? []), ...(spec.read ?? []), ...(spec.write ?? [])];
  const equals = arg.indexOf('=');
  const name = equals < 0 ? arg : arg.slice(0, equals);
  if (names.includes(name) && (equals < 0 || name.length > 2 || spec.shortEquals)) {
    return [name, equals < 0 ? undefined : arg.slice(equals + 1)];
  }
  if (spec.compactShort && /^-[^-]/.test(arg)) {
    for (let i = 1; i < arg.length; i++) {
      const short = `-${arg[i]}`;
      if (names.includes(short)) {
        const attached = arg.slice(i + 1);
        return [short, spec.shortEquals && attached.startsWith('=') ? attached.slice(1) : attached || undefined];
      }
      if (!spec.flags.test(short)) break;
    }
  }
}

async function inspectOptions(
  policy: PolicyPaths, cwd: string, args: readonly string[], spec: Options, displayOptions = false,
): Promise<string[]> {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return [...operands, ...args.slice(i + 1)];
    if (arg === '-' || !arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    if (spec.flags.test(arg) || displayOptions && ['--help', '--version'].includes(arg)) {
      spec.onFlag?.(arg);
      continue;
    }
    const option = valueOption(arg, spec);
    if (!option) {
      ask(policy);
      continue;
    }
    const [name, attached] = option;
    const next = args[i + 1];
    const value = attached ?? (next !== undefined && (next === '-' || !next.startsWith('-') || /^-\d/.test(next))
      ? args[++i] : undefined);
    const write = spec.write?.includes(name) ?? false;
    if (value === undefined || spec.validValue?.(name, value) === false) {
      ask(policy);
      continue;
    }
    spec.onValue?.(name, value);
    if (write || spec.read?.includes(name)) {
      if (value === '-') {
        ask(policy);
        continue;
      }
      const checked = policy.checks.length;
      const path = await inspectPath(policy, value, cwd, write);
      if (!write && spec.readableFiles && path && policy.checks.length === checked) {
        if (!(await stat(path).catch(() => null))?.isFile() || !await access(path, constants.R_OK).then(() => true, () => false)) ask(policy);
      }
      const root = !write && spec.outputRoot?.(name, value);
      if (root) await inspectPath(policy, root, cwd, true);
    }
  }
  return operands;
}

export const readOnlyOptions: Record<string, Options> = {
  cat: { flags: /^(?:-[AbEenstTuv]+|--(?:show-all|number-nonblank|show-ends|number|squeeze-blank|show-tabs|show-nonprinting))$/ },
  head: { flags: /^(?:-[qvz]+|-\d+|--(?:quiet|silent|verbose|zero-terminated))$/, values: ['-n', '-c', '--lines', '--bytes'] },
  tail: { flags: /^(?:-[qvz]+|-\d+|--(?:quiet|silent|verbose|zero-terminated))$/, values: ['-n', '-c', '--lines', '--bytes'] },
  wc: { flags: /^(?:-[cmlLw]+|--(?:bytes|chars|lines|max-line-length|words))$/, values: ['--total'] },
  stat: { flags: /^(?:-[Lft]+|--(?:dereference|file-system|terse))$/, values: ['-c', '--format', '--printf', '--cached'] },
  ls: {
    flags: /^(?:-[aAbBcCdDfFgGhHiHklmnNopqQrRsStuUvxXZ1]+|--(?:all|almost-all|author|escape|ignore-backups|directory|dired|file-type|full-time|group-directories-first|no-group|human-readable|si|dereference-command-line|dereference-command-line-symlink-to-dir|inode|kibibytes|numeric-uid-gid|literal|hide-control-chars|show-control-chars|quote-name|reverse|recursive|size|context|zero)|--(?:color|classify|hyperlink)(?:=(?:always|auto|never))?)$/,
    values: ['--block-size', '--format', '--hide', '--indicator-style', '-I', '--ignore', '--quoting-style',
      '--sort', '--time', '--time-style', '-T', '--tabsize', '-w', '--width'],
  },
  readlink: { flags: /^(?:-[femnqsvz]+|--(?:canonicalize|canonicalize-existing|canonicalize-missing|no-newline|quiet|silent|verbose|zero))$/ },
  realpath: {
    flags: /^(?:-[emLPqsz]+|--(?:canonicalize-existing|canonicalize-missing|logical|physical|quiet|strip|no-symlinks|zero))$/,
    read: ['--relative-to', '--relative-base'],
  },
  du: {
    flags: /^(?:-[0abcDHhklmPSsx]+|--(?:null|all|apparent-size|bytes|total|dereference-args|human-readable|inodes|count-links|no-dereference|separate-dirs|si|summarize|one-file-system)|--time(?:=.+)?)$/,
    values: ['-B', '--block-size', '-d', '--max-depth', '-t', '--threshold', '--time-style', '--exclude'],
    read: ['-X', '--exclude-from'],
  },
  cut: {
    flags: /^(?:-[nsz]+|--(?:complement|only-delimited|zero-terminated))$/,
    values: ['-b', '--bytes', '-c', '--characters', '-d', '--delimiter', '-f', '--fields', '--output-delimiter'],
  },
  nl: {
    flags: /^(?:-p|--no-renumber)$/,
    values: ['-b', '--body-numbering', '-d', '--section-delimiter', '-f', '--footer-numbering', '-h', '--header-numbering',
      '-i', '--line-increment', '-l', '--join-blank-lines', '-n', '--number-format', '-s', '--number-separator',
      '-v', '--starting-line-number', '-w', '--number-width'],
  },
};

export async function inspectReadOnly(policy: PolicyPaths, cwd: string, args: string[], spec: Options): Promise<void> {
  const operands = await inspectOptions(policy, cwd, args, { ...spec, compactShort: true }, true);
  for (const operand of operands) if (operand !== '-') await inspectPath(policy, operand, cwd, false);
}

const searchPatterns = ['-e', '--regexp', '-f', '--file'];
const searchValues = ['-A', '-B', '-C', '-m', '--after-context', '--before-context', '--context', '--max-count'];
const searchOptions: Record<'rg' | 'grep', Options> = {
  rg: {
    flags: /^(?:-[.0FHIPSUabchilNnopqsuvwxV]+|--(?:byte-offset|case-sensitive|column|count|count-matches|files|files-with-matches|files-without-match|fixed-strings|heading|hidden|ignore-case|invert-match|json|line-buffered|line-number|line-regexp|multiline|no-config|no-filename|no-heading|no-hidden|no-ignore|no-line-number|no-messages|no-unicode|null|null-data|only-matching|passthru|pcre2|pretty|quiet|smart-case|stats|text|trim|unrestricted|vimgrep|with-filename|word-regexp))$/,
    values: [...searchValues, '-e', '--regexp', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--color',
      '--colors', '-d', '--max-depth', '--max-filesize', '-M', '--max-columns', '--sort', '--sortr', '-j', '--threads',
      '-E', '--encoding', '-r', '--replace'],
    read: ['-f', '--file', '--ignore-file'],
    compactShort: true,
    shortEquals: true,
  },
  grep: {
    flags: /^(?:-[0-9]+|-[EFGHILPTUVZabchilnoqrsvwx]+|--(?:basic-regexp|byte-offset|count|extended-regexp|files-with-matches|files-without-match|fixed-strings|ignore-case|invert-match|line-buffered|line-number|line-regexp|no-filename|no-messages|null|null-data|only-matching|perl-regexp|quiet|recursive|silent|text|with-filename|word-regexp)|--colou?r(?:=(?:always|auto|never))?)$/,
    values: [...searchValues, '-e', '--regexp', '--include', '--exclude', '--exclude-dir', '--binary-files'],
    read: ['-f', '--file', '--exclude-from'],
    compactShort: true,
  },
};

export async function inspectSearch(policy: PolicyPaths, cwd: string, program: 'rg' | 'grep', args: string[]): Promise<void> {
  if (program === 'rg' ? process.env.RIPGREP_CONFIG_PATH : process.env.POSIXLY_CORRECT) ask(policy);
  let explicitPattern = false;
  let filesOnly = false;
  const operands = await inspectOptions(policy, cwd, args, {
    ...searchOptions[program],
    onFlag: flag => { filesOnly ||= flag === '--files'; },
    onValue: name => { explicitPattern ||= searchPatterns.includes(name); },
  }, true);
  for (const operand of explicitPattern || filesOnly ? operands : operands.slice(1)) {
    if (operand !== '-') await inspectPath(policy, operand, cwd, false);
  }
}

export async function inspectGitCommit(policy: PolicyPaths, cwd: string, args: string[]): Promise<void> {
  const operands = await inspectOptions(policy, cwd, args, {
    flags: /^(?:-[aqvs]+|--(?:all|quiet|verbose|allow-empty|signoff))$/,
    values: ['-m', '--message'],
    read: ['-F', '--file', '-t', '--template'],
    compactShort: true,
    readableFiles: true,
  });
  if (operands.length) ask(policy);
}

export const buildPrograms = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'pytest', 'vitest', 'jest', 'eslint', 'cargo', 'go', 'make']);
const packageManagers = new Set(['npm', 'pnpm', 'yarn']);
const packageScriptName = /^[a-z0-9_][a-z0-9_.:-]*$/i;
const packageConfigs = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', 'pnpm-workspace.yaml'];
const runnerConfigs: Record<string, string[]> = {
  pytest: ['pytest.ini', '.pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'conftest.py'],
  cargo: ['.cargo/config', '.cargo/config.toml'],
  go: ['go.work'],
};
for (const extension of ['js', 'ts', 'cjs', 'mjs', 'cts', 'mts', 'json']) {
  (runnerConfigs.vitest ??= []).push('vitest.config.' + extension, 'vite.config.' + extension);
  (runnerConfigs.jest ??= []).push('jest.config.' + extension);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function hasConfig(cwd: string, names: string[]): Promise<boolean> {
  for (let directory = cwd; ; directory = posix.dirname(directory)) {
    if ((await Promise.all(names.map(name => exists(join(directory, name))))).some(Boolean)) return true;
    if (directory === '/') return false;
  }
}

export async function inspectLocalNodeModule(policy: PolicyPaths, cwd: string, name: string, binary = false): Promise<boolean> {
  const project = policy.project?.path;
  for (let directory = cwd; ; directory = posix.dirname(directory)) {
    const location = join(directory, 'node_modules', binary ? '.bin' : '', name);
    if (await exists(location)) {
      const checked = policy.checks.length;
      const physical = await inspectPath(policy, location, undefined, false);
      if (!physical || policy.checks.length !== checked) return false;
      const meta = await stat(physical).catch(() => null);
      return binary ? meta?.isFile() === true : meta?.isDirectory() === true;
    }
    if (!project || !under(directory, project) || directory === project) return false;
  }
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readJsonObject(policy: PolicyPaths, cwd: string, name: string, comments = false): Promise<Record<string, unknown> | undefined> {
  const checked = policy.checks.length;
  const path = await inspectPath(policy, name, cwd, false);
  if (!path || policy.checks.length !== checked) return;
  try {
    if (!(await stat(path)).isFile()) return;
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const limit = 256 * 1024;
      const meta = await file.stat();
      if (!meta.isFile() || meta.size > limit) return;
      const buffer = Buffer.alloc(meta.size);
      const { bytesRead } = await file.read(buffer, 0, meta.size, 0);
      if (bytesRead !== meta.size || (await file.stat()).size !== meta.size) return;
      let source = buffer.toString('utf8');
      if (comments) {
        const stripComments = /"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
        const stripTrailingCommas = /"(?:[^"\\]|\\.)*"|,(?=\s*[\]}])/g;
        source = source.replace(/^\uFEFF/, '').replace(stripComments, token => token.startsWith('/') ? ' ' : token)
          .replace(stripTrailingCommas, token => token === ',' ? '' : token);
      }
      const value: unknown = JSON.parse(source);
      if (jsonObject(value)) return value;
    } finally {
      await file.close();
    }
  } catch {
    return;
  }
}

export function readPackageManifest(policy: PolicyPaths, cwd: string): Promise<Record<string, unknown> | undefined> {
  return readJsonObject(policy, cwd, 'package.json');
}

export async function inspectPackageScripts(
  policy: PolicyPaths, cwd: string, program: string, args: string[], inspectScript: (script: string) => Promise<void>,
): Promise<boolean> {
  if (!packageManagers.has(program)) return false;
  const [first, second] = args;
  const run = first === 'run' || program === 'npm' && first === 'run-script';
  const test = first === 'test' || program === 'npm' && first === 't';
  if (!run && !test) return false;
  const name = run ? second : 'test';
  if (!name || !packageScriptName.test(name)) {
    ask(policy);
    return true;
  }
  const extra = args.slice(run ? 2 : 1);
  const separator = extra.indexOf('--');
  const options = separator < 0 ? extra : extra.slice(0, separator);
  if (options.some(flag => program !== 'npm' || !['-s', '--silent'].includes(flag))
    || separator >= 0 && separator !== extra.length - 1) ask(policy);
  await inspectPath(policy, cwd, cwd, true);
  if (process.env.NODE_OPTIONS || process.env.npm_config_script_shell || process.env.NPM_CONFIG_SCRIPT_SHELL
    || await hasConfig(cwd, packageConfigs) || await hasConfig(policy.home, packageConfigs)) ask(policy);
  const manifest = await readPackageManifest(policy, cwd);
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts) || !Object.hasOwn(scripts, name)) {
    ask(policy);
    return true;
  }
  for (const script of ['pre' + name, name, 'post' + name]) {
    if (!Object.hasOwn(scripts, script)) continue;
    const source: unknown = Reflect.get(scripts, script);
    if (typeof source !== 'string' || !source.trim()) ask(policy);
    else await inspectScript(source);
  }
  return true;
}
const testRunnerOutput = ['--coverageDirectory', '--outputFile', '--output-file'];
const tscBooleanOptions = new Set(['--noEmit', '--pretty', '--strict', '--incremental', '--declaration', '--emitDeclarationOnly',
  '--skipLibCheck', '--noUnusedLocals', '--noUnusedParameters', '--listFiles', '--listEmittedFiles', '--showConfig',
  '--diagnostics', '--extendedDiagnostics', '--noEmitOnError']);
const tscOutputPaths = ['outDir', 'declarationDir', 'tsBuildInfoFile', 'outFile'] as const;

async function findTscConfig(policy: PolicyPaths, cwd: string, project: string | undefined): Promise<string | undefined> {
  if (project !== undefined) {
    const path = await inspectPath(policy, project, cwd, false);
    if (!path) return;
    const logical = resolve(cwd, project);
    return (await stat(path).catch(() => null))?.isDirectory() ? join(logical, 'tsconfig.json') : logical;
  }
  for (let directory = cwd; ; directory = posix.dirname(directory)) {
    const file = join(directory, 'tsconfig.json');
    if (await exists(file)) return file;
    if (directory === '/') return;
  }
}

function tscPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f]|\$\{|:/.test(value);
}

async function inspectTsc(policy: PolicyPaths, cwd: string, args: string[]): Promise<void> {
  const flags = new Map<string, boolean>();
  const values = new Map<string, string>();
  let displayOnly = false;
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!tscBooleanOptions.has(arg)) {
      normalized.push(arg);
      continue;
    }
    const next = args[i + 1];
    normalized.push(`${arg}=${next === 'true' || next === 'false' || next === 'null' ? args[++i] : 'true'}`);
  }
  const operands = await inspectOptions(policy, cwd, normalized, {
    flags: /^-v$/,
    values: ['-p', '--project', '--rootDir', ...tscBooleanOptions, ...tscOutputPaths.map(name => `--${name}`)],
    validValue: (name, value) => tscBooleanOptions.has(name) ? ['true', 'false'].includes(value) : value !== 'null' && tscPath(value),
    onFlag: () => { displayOnly = true; },
    onValue: (name, value) => {
      if (tscBooleanOptions.has(name)) flags.set(name.slice(2), value === 'true');
      else values.set(name === '-p' ? 'project' : name.slice(2), value);
    },
  }, true);
  for (const operand of operands) {
    if (operand.startsWith('@') || operand.startsWith('-') || !tscPath(operand)) ask(policy);
    else await inspectPath(policy, operand, cwd, false);
  }
  const project = values.get('project');
  if (operands.length && project !== undefined || args.includes('--')) ask(policy);
  const configPath = operands.length && project === undefined ? undefined : await findTscConfig(policy, cwd, project);
  const config = configPath ? await readJsonObject(policy, cwd, configPath, true) : undefined;
  if ((configPath || project !== undefined) && !config || config && Object.hasOwn(config, 'extends')) ask(policy);
  const compilerOptions = config?.compilerOptions;
  if (compilerOptions !== undefined && !jsonObject(compilerOptions)) ask(policy);
  const options = jsonObject(compilerOptions) ? compilerOptions : {};
  const configDir = configPath ? posix.dirname(configPath) : cwd;
  const output = (name: string): string | undefined => {
    const direct = values.get(name);
    const value = direct ?? options[name];
    if (value === undefined) return;
    if (!tscPath(value)) {
      ask(policy);
      return;
    }
    return resolve(direct !== undefined ? cwd : configDir, value);
  };
  const outDir = output('outDir');
  const declarationDir = output('declarationDir');
  const infoFile = output('tsBuildInfoFile');
  const outFile = output('outFile');
  const rootDir = output('rootDir');
  const enabled = (name: string) => flags.get(name) ?? options[name] === true;
  if (rootDir) await inspectPath(policy, rootDir, undefined, false);
  for (const name of ['incremental', 'composite', 'noEmit', 'noEmitOnError', 'emitDeclarationOnly']) {
    if (Object.hasOwn(options, name) && typeof options[name] !== 'boolean') ask(policy);
  }
  if (['out', 'generateTrace', 'generateCpuProfile'].some(name => Object.hasOwn(options, name))) ask(policy);
  if (displayOnly || flags.get('showConfig')) return;
  const incremental = enabled('incremental') || enabled('composite');
  if (infoFile && (!enabled('noEmit') || incremental || values.has('tsBuildInfoFile'))) {
    await inspectPath(policy, infoFile, undefined, true);
  }
  if (!enabled('noEmit')) {
    if (!outDir && !(enabled('emitDeclarationOnly') && declarationDir)) ask(policy);
    if (outDir) await inspectOutputDirectory(policy, outDir, cwd);
    if (declarationDir) await inspectOutputDirectory(policy, declarationDir, cwd);
    if (rootDir && (!policy.project || !under(rootDir, policy.project.path)) && !enabled('noEmitOnError')) ask(policy);
  }
  if (outFile && (!enabled('noEmit') || incremental || values.has('outFile'))) {
    await inspectPath(policy, outFile, undefined, true);
    ask(policy);
  }
  if (!infoFile && !outFile && incremental && configPath) {
    const base = configPath.replace(/(?:\.d\.[cm]?ts|\.[cm]?[jt]s|\.[jt]sx|\.json)$/, '');
    const sourceRoot = rootDir ?? (enabled('composite') ? configDir : undefined);
    const defaultInfo = outDir
      ? resolve(outDir, sourceRoot ? relative(sourceRoot, base) : posix.basename(base))
      : base;
    await inspectPath(policy, defaultInfo + '.tsbuildinfo', undefined, true);
  }
}

const buildOptions: Record<string, Options> = {
  pytest: {
    flags: /^(?:-[vqxl]+|--(?:verbose|quiet|exitfirst|collect-only|disable-warnings|strict-config|strict-markers|showlocals))$/,
    values: ['--tb', '-k', '-m', '--maxfail', '--durations', '--color'],
    read: ['--rootdir'],
    write: ['--junitxml', '--junit-xml', '--basetemp', '--log-file', '--result-log'],
    compactShort: true,
    outputRoot: (_name, value) => value,
  },
  vitest: {
    flags: /^--(?:run|passWithNoTests|silent|globals)$/,
    values: ['-t', '--testNamePattern', '--maxWorkers', '--bail'],
    read: ['-r', '--root', '--dir'],
    write: [...testRunnerOutput, '--coverage.reportsDirectory'],
    outputRoot: (name, value) => name === '--dir' ? undefined : value,
  },
  jest: {
    flags: /^(?:--(?:runInBand|passWithNoTests|silent|verbose|listTests|showConfig|ci|bail|no-cache)|-i)$/,
    values: ['-t', '--testNamePattern', '--maxWorkers'],
    read: ['--rootDir'],
    write: [...testRunnerOutput, '--cacheDirectory'],
    outputRoot: (_name, value) => value,
  },
  eslint: {
    flags: /^(?:-v|--(?:quiet|debug|no-ignore|no-cache|no-config-lookup))$/,
    values: ['-f', '--format', '--max-warnings'],
    write: ['-o', '--output-file', '--cache-location'],
    validValue: (name, value) => !['-f', '--format'].includes(name)
      || ['stylish', 'json', 'json-with-metadata', 'html'].includes(value),
  },
  cargo: {
    flags: /^(?:-[qv]+|--(?:quiet|verbose|release|all-targets|lib|bins|tests|examples|benches|locked|offline|frozen|no-run|no-fail-fast|all-features|no-default-features))$/,
    values: ['-p', '--package', '--features', '-F', '--bin', '--test', '--example', '--jobs', '-j', '--color', '--message-format'],
    read: ['--manifest-path'],
    write: ['--target-dir'],
    compactShort: true,
    outputRoot: (_name, value) => posix.dirname(value),
  },
  go: {
    flags: /^(?:-(?:v|race|short|failfast|cover|trimpath|buildvcs=false|n|x|a|json))$/,
    values: ['-count', '-run', '-bench', '-benchtime', '-timeout', '-parallel', '-tags', '-cpu', '-covermode'],
    write: ['-o', '-coverprofile'],
    shortEquals: true,
  },
  make: {
    flags: /^(?:-[knqs]+|--(?:keep-going|just-print|dry-run|recon|question|silent|quiet|no-print-directory|print-directory))$/,
    read: ['-f', '--file', '--makefile'],
    compactShort: true,
  },
};

export async function inspectBuild(policy: PolicyPaths, cwd: string, program: string, args: string[]): Promise<boolean> {
  const [first = ''] = args;
  if (['npx', 'pnpm', 'yarn'].includes(program) && ['tsc', 'vitest', 'jest', 'eslint'].includes(first)) {
    if (!await inspectLocalNodeModule(policy, cwd, first, true)) ask(policy);
    if (await hasConfig(cwd, packageConfigs) || await hasConfig(policy.home, packageConfigs)) ask(policy);
    const scripts = (await readPackageManifest(policy, cwd))?.scripts;
    if (program !== 'npx' && scripts && typeof scripts === 'object' && Object.hasOwn(scripts, first)) ask(policy);
    return inspectBuild(policy, cwd, first, args.slice(1));
  }
  if (program === 'tsc') {
    await inspectTsc(policy, cwd, args);
    return true;
  }
  const spec = Object.hasOwn(buildOptions, program) ? buildOptions[program] : undefined;
  if (!spec || (program === 'cargo' && !['test', 'build', 'check', 'clippy'].includes(first))
    || (program === 'go' && !['test', 'build', 'vet'].includes(first))) return false;
  const hasSubcommand = program === 'cargo' || program === 'go';
  const options = hasSubcommand ? args.slice(1) : args;
  if (program === 'make' || hasSubcommand && options.includes('--')) ask(policy);
  const configs = runnerConfigs[program];
  if (configs && await hasConfig(cwd, configs)) ask(policy);
  if (configs && spec.read?.some(flag => options.some(arg => arg === flag || arg.startsWith(flag + '=')))) ask(policy);
  if (program === 'cargo' && (process.env.RUSTC || process.env.RUSTC_WRAPPER || process.env.RUSTC_WORKSPACE_WRAPPER
    || await hasConfig(resolve(cwd, process.env.CARGO_HOME ?? join(policy.home, '.cargo')), ['config', 'config.toml']))) ask(policy);
  if (program === 'go' && (process.env.GOFLAGS || process.env.GOWORK)) ask(policy);
  if (program === 'pytest' && (process.env.PYTEST_ADDOPTS || process.env.PYTEST_PLUGINS)) ask(policy);
  if (program === 'jest' && Object.hasOwn(await readPackageManifest(policy, cwd) ?? {}, 'jest')) ask(policy);
  const operands = await inspectOptions(policy, cwd, options, spec, true);
  for (const operand of operands) {
    if (operand.startsWith('@') || operand.startsWith('-')) ask(policy);
    else if (program !== 'make') await inspectPath(policy, operand, cwd, false);
  }
  await inspectPath(policy, cwd, cwd, true);
  return true;
}
