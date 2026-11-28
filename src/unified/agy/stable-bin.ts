import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, type Stats,
} from 'node:fs';
import { basename, join } from 'node:path';

const USERNS_RESTRICT_PATH = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const APPARMOR_PROFILE_PATH = '/etc/apparmor.d/agy-zhangzy';
const VERSIONED_BIN = /^agy-[0-9a-f]{12}$/;

type StableBinOptions = {
  stableBinDir?: string;
  sandbox?: boolean;
  appArmorProfilePath?: string;
  usernsRestrictPath?: string;
  onWarning?: (msg: string) => void;
};

function fingerprint(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');
}

function appArmorCovers(path: string, options: StableBinOptions): boolean {
  let restriction: string;
  try {
    restriction = readFileSync(options.usernsRestrictPath ?? USERNS_RESTRICT_PATH, 'utf8').trim();
  } catch (err) {
    // Older kernels without this sysctl lack the AppArmor restriction.
    return options.usernsRestrictPath === undefined && (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (restriction === '0') return true;
  if (restriction !== '1') return false;

  let profile: string;
  try {
    profile = readFileSync(options.appArmorProfilePath ?? APPARMOR_PROFILE_PATH, 'utf8');
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
  // Accept simple attachment declarations with a direct userns grant.
  // Unknown syntax, nested profiles and includes inside the profile fail closed.
  const declaration = /^\s*(?:(?:abi[ \t]+<abi\/[\d.]+>,|#?include[ \t]+<tunables\/global>)\s*)*(?:profile\s+(?:[\w.-]+\s+)?)?("[^"\n]+"|\/[^\s{}]+)\s*(?:flags=\([^()\n]*\)\s*)?\{([^{}]*)\}\s*$/
    .exec(profile.replace(/(^|[ \t])#(?!include\b).*$/gm, ''));
  if (!declaration) return false;
  const [, attachment, rules] = declaration;
  if (!/(?:^|,)\s*(?:allow\s+)?userns\s*,/.test(rules!)
      || /\b(?:deny|include)\b/.test(rules!)) return false;

  const pattern = attachment!.replace(/^"|"$/g, '');
  if (!pattern.startsWith('/') || /[{}\[\]\\]/.test(pattern)) return false;
  const expression = pattern.split(/(\*\*|\*|\?)/).map(part => {
    if (part === '**') return '.*';
    if (part === '*') return '[^/]*';
    if (part === '?') return '[^/]';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${expression}$`).test(path);
}

export function prepareStableAgyBin(
  agyBin: string,
  options: StableBinOptions = {},
): { execPath: string; staged: boolean; reason?: string } {
  const stableBinDir = options.stableBinDir ?? process.env.FEISHU_AGY_STABLE_BIN_DIR;
  if (!stableBinDir) return { execPath: agyBin, staged: false, reason: 'stable_bin_dir_unset' };
  const source = realpathSync(agyBin);
  const fd = openSync(source, 'r');
  let identity: string;
  let version: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Agy binary is not a regular file: ${agyBin}`);
    identity = fingerprint(stat);
    const prefix = Buffer.alloc(64 * 1024);
    const length = readSync(fd, prefix, 0, prefix.length, 0);
    version = createHash('sha256').update(identity).update(prefix.subarray(0, length)).digest('hex').slice(0, 12);
  } finally {
    closeSync(fd);
  }

  mkdirSync(stableBinDir, { recursive: true, mode: 0o700 });
  const dir = realpathSync(stableBinDir);
  const stagedPath = join(dir, `agy-${version}`);
  if (options.sandbox === true && process.platform === 'linux' && !appArmorCovers(stagedPath, options)) {
    options.onWarning?.(`Using ${agyBin} for sandboxed Agy. To enable binary staging, load an AppArmor profile with a userns grant for ${dir}/agy-*.`);
    return { execPath: agyBin, staged: false, reason: 'apparmor_path_restricted' };
  }

  const existing = lstatSync(stagedPath, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error(`Invalid staged Agy binary: ${stagedPath}`);
  if (!existing) {
    const scratch = mkdtempSync(join(dir, '.agy-stage-'));
    const tempPath = join(scratch, 'agy');
    try {
      let copied = false;
      try {
        linkSync(source, tempPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes(code ?? '')) throw err;
        copyFileSync(source, tempPath);
        chmodSync(tempPath, 0o700);
        copied = true;
      }
      if (identity !== fingerprint(statSync(copied ? source : tempPath))) {
        // The updater replaced the source between fingerprinting and staging.
        throw Object.assign(new Error(`Agy binary changed while staging: ${agyBin}`), { code: 'ETXTBSY' });
      }
      renameSync(tempPath, stagedPath);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const older = readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isFile() || entry.name === basename(stagedPath) || !VERSIONED_BIN.test(entry.name)) return [];
    const path = join(dir, entry.name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat?.isFile() ? [{ path, updated: stat.ctimeMs }] : [];
  });
  older.sort((a, b) => b.updated - a.updated || b.path.localeCompare(a.path));
  for (const { path } of older.slice(2)) rmSync(path, { force: true });
  return { execPath: stagedPath, staged: true };
}
