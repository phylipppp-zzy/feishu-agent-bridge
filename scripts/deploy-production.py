#!/usr/bin/env python3
"""Build a sealed production release of feishu-agent-bridge and update config + systemd unit."""
import argparse
import fcntl
import hashlib
import inspect
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from tempfile import NamedTemporaryFile

REPO = Path('/home/zhangzy/workspace/feishu-agent-bridge')
RELEASES_ROOT = Path('/home/zhangzy/.local/share/feishu-unified-bridge/releases')
CONF_DIR = Path('/home/zhangzy/.config/feishu-unified-bridge')
CONF_FILE = CONF_DIR / 'config.json'
UNIT_FILE = Path('/home/zhangzy/.config/systemd/user/feishu-unified-production.service')
PARENT_RELEASE = '607c887-agy-320eaa1fba6a'
CORE_DB = Path('/home/zhangzy/.local/state/feishu-unified-bridge/core.sqlite')


def check_active_work(core_db: Path) -> bool:
    try:
        core_db.stat()
    except FileNotFoundError:
        return False

    queries = (
        ('Turn', "SELECT session_id, id, json_extract(value,'$.status'), json_extract(value,'$.startedAt') "
                 "FROM turns WHERE json_extract(value,'$.status') IN ('running','queued')"),
        ('Outbox', "SELECT operation_id, kind, state FROM outbox WHERE state IN ('pending','in_flight') "
                   "UNION ALL SELECT operation_id, kind, state FROM steer_outbox_v1 WHERE state IN ('pending','in_flight')"),
        ('Interaction awaiting answer', "SELECT id, session_id, json_extract(value,'$.kind') "
                                        "FROM interactions WHERE json_extract(value,'$.status')='awaiting_answer'"),
    )
    with closing(sqlite3.connect(core_db.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        active = [(label, db.execute(sql).fetchall()) for label, sql in queries]

    if not any(rows for _, rows in active):
        return False
    print('Deploy blocked by active bridge work:', file=sys.stderr)
    for label, rows in active:
        for row in rows:
            print(f'  {label}: ' + ' / '.join(str(value) for value in row if value is not None), file=sys.stderr)
    print('Drain active work before deploying, or pass --force to bypass this check.', file=sys.stderr)
    return True


def release_from_path(path: Path) -> Path | None:
    root = RELEASES_ROOT.resolve()
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        return None
    relative = resolved.relative_to(root)
    return root / relative.parts[0] if relative.parts else None


def unit_releases(unit_content: str) -> set[Path]:
    # The generated unit uses absolute, unquoted paths without spaces.
    return {release for value in re.findall(r'(?<=[=\s"])/[^\s"]+', unit_content)
            if (release := release_from_path(Path(value))) is not None}


def running_releases() -> set[Path]:
    protected = set()
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            argv = [os.fsdecode(arg) for arg in (proc / 'cmdline').read_bytes().split(b'\0') if arg]
            launcher = next((arg for arg in argv if Path(arg).name == 'unified-start.mjs'), None)
            if launcher is not None:
                script = Path(launcher)
                if not script.is_absolute():
                    script = (proc / 'cwd').readlink() / script
                if (release := release_from_path(script)) is not None:
                    protected.add(release)
            elif argv and Path(argv[0]).name == 'feishu-unified-bridge':
                if (release := release_from_path((proc / 'cwd').readlink())) is not None:
                    protected.add(release)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            # Processes can disappear during the scan or belong to another user.
            continue
    return protected


def prune_releases(release_dir: Path, previous_unit: str, keep: int) -> None:
    release_pattern = re.compile(r'[0-9a-f]{7,40}(?:-[a-zA-Z0-9-]+)?')
    candidates = sorted(
        (p for p in RELEASES_ROOT.resolve().iterdir()
         if release_pattern.fullmatch(p.name) and not p.is_symlink() and p.is_dir()),
        key=lambda p: (p.stat().st_mtime_ns, p.name),
        reverse=True,
    )
    protected = (unit_releases(previous_unit) | unit_releases(UNIT_FILE.read_text(encoding='utf-8'))
                 | running_releases() | {release_dir.resolve()})
    # The new release is retained separately from the requested old releases.
    newest_old = [path for path in candidates if path != release_dir.resolve()][:keep]
    for candidate in candidates:
        if candidate not in protected and candidate not in newest_old:
            shutil.rmtree(candidate)
            print(f'PRUNED_RELEASE={candidate.name}')


def validate_agy_sandbox(runtime):
    approval_disabled = runtime.get('approvalPolicy', {}).get('enabled') is False
    agy = runtime.get('agy')
    if approval_disabled and (not isinstance(agy, dict) or agy.get('sandbox') is not True):
        raise RuntimeError('agy.sandbox must be explicitly true when approvalPolicy.enabled is false')
    extra_args = agy.get('extraArgs', []) if isinstance(agy, dict) else []
    if not isinstance(extra_args, list) or any(
        not isinstance(arg, str) or not arg.strip() or '\0' in arg for arg in extra_args
    ):
        raise RuntimeError('agy.extraArgs must be a list of non-empty strings without NUL bytes')
    if not approval_disabled:
        return
    args = [arg.strip().lower() for arg in extra_args]
    disabled = {'false', 'off', '0'}
    for index, arg in enumerate(args):
        flag, sep, value = arg.partition('=')
        if flag == '--no-sandbox' or (flag == '--sandbox' and (
            (sep and value.strip() in disabled) or
            (not sep and index + 1 < len(args) and args[index + 1] in disabled)
        )):
            raise RuntimeError('agy.extraArgs must preserve the sandbox when approvalPolicy.enabled is false')

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--force', action='store_true', help='Bypass the active-work check')
parser.add_argument('--core-db', type=Path, default=CORE_DB, help='Path to the bridge core SQLite database')
parser.add_argument('--keep-releases', type=int, default=8, help='Number of newest old releases to keep (default: 8)')
parser.add_argument('--check-active-only', action='store_true', help='Check for active work without deploying')
args = parser.parse_args()
if args.keep_releases < 0:
    parser.error('--keep-releases must be non-negative')
try:
    if not args.force and check_active_work(args.core_db):
        sys.exit(2)
except (OSError, sqlite3.Error) as exc:
    print(f'Cannot check active bridge work in {args.core_db}: {exc}', file=sys.stderr)
    sys.exit(1)
if args.check_active_only:
    sys.exit(0)

RELEASES_ROOT.mkdir(parents=True, exist_ok=True)
# Hold through staging, unit publication and GC so deploys cannot prune each other's releases.
deploy_lock = os.open(RELEASES_ROOT, os.O_RDONLY | os.O_DIRECTORY)
fcntl.flock(deploy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
previous_unit = UNIT_FILE.read_text(encoding='utf-8') if UNIT_FILE.exists() else ''

commit = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', '--short', 'HEAD'], text=True).strip()
branch = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', '--abbrev-ref', 'HEAD'], text=True).strip()

def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def build_manifest(base: Path, files: list[Path]) -> str:
    lines = []
    for p in sorted(files, key=lambda x: str(x.relative_to(base))):
        lines.append(f"{sha256_file(p)}  {p.relative_to(base)}")
    return "\n".join(lines) + "\n"

# 1. Stage release into a temp directory under RELEASES_ROOT, then rename to final deterministic name
staging = RELEASES_ROOT / f".staging-{commit}-{os.getpid()}"
if staging.exists():
    shutil.rmtree(staging)
staging.mkdir(parents=True, mode=0o700)

for d in ('dist', 'scripts', 'src', 'test'):
    shutil.copytree(REPO / d, staging / d, symlinks=False)
for f in ('package.json', 'package-lock.json', 'tsconfig.json'):
    shutil.copy2(REPO / f, staging / f)
os.symlink(str(REPO / 'node_modules'), str(staging / 'node_modules'))

dist_files = [p for p in (staging / 'dist').rglob('*') if p.is_file()]
dist_manifest = build_manifest(staging, dist_files)
(staging / 'dist.sha256').write_text(dist_manifest, encoding='utf-8')
dist_manifest_sha = hashlib.sha256(dist_manifest.encode('utf-8')).hexdigest()

source_files = [
    p for root in ('src', 'scripts', 'test') for p in (staging / root).rglob('*') if p.is_file()
] + [staging / 'package.json', staging / 'package-lock.json', staging / 'tsconfig.json']
source_manifest = build_manifest(staging, source_files)
(staging / 'source.sha256').write_text(source_manifest, encoding='utf-8')
source_manifest_sha = hashlib.sha256(source_manifest.encode('utf-8')).hexdigest()
start_script_sha = sha256_file(staging / 'scripts/unified-start.mjs')

release_base = f"{commit}-agy-{source_manifest_sha[:12]}"
release_name = release_base
release_dir = RELEASES_ROOT / release_name
# A previous deployment of the same source may still be running or referenced.
sequence = 1
while release_dir.exists() or release_dir.is_symlink():
    sequence += 1
    release_name = f"{release_base}-{sequence}"
    release_dir = RELEASES_ROOT / release_name

generation = {
    "commit": commit,
    "branch": branch,
    "parentRelease": PARENT_RELEASE,
    "distManifestSha256": dist_manifest_sha,
    "sourceManifestSha256": source_manifest_sha,
    "release": release_name,
}
(staging / 'generation.json').write_text(json.dumps(generation, indent=2) + "\n", encoding='utf-8')

preflight_code = f'''#!/usr/bin/env python3
"""Offline launch preflight. No network, native process, or database writes."""
import hashlib, json, os, shutil, sqlite3, subprocess, sys
from pathlib import Path
RELEASE = Path({str(release_dir)!r})
CONF = Path('/home/zhangzy/.config/feishu-unified-bridge')
STATE = Path('/home/zhangzy/.local/state/feishu-unified-bridge')
MAN = RELEASE / 'dist.sha256'
EXPECTED = {dist_manifest_sha!r}
{inspect.getsource(validate_agy_sandbox)}
def ok(v):
    if not v:
        raise RuntimeError('preflight rejected')
try:
    p = CONF / 'config.json'
    s = p.lstat()
    ok(p.is_file() and not p.is_symlink() and s.st_uid == os.getuid() and not s.st_mode & 0o077)
    c = json.loads(p.read_text())
    r = c['runtime']
    validate_agy_sandbox(r)
    context = json.loads((CONF / 'root-check-context.json').read_text())
    candidates = json.loads((CONF / 'root-candidates-private.json').read_text())['records']
    ok(len(candidates) == 136 and all(x['chatId'] == r['allowedDestinations'][0] for x in candidates))
    owner = os.environ.get('FEISHU_OWNER_OPEN_ID')
    app = os.environ.get('FEISHU_APP_ID')
    ok(owner and app and os.environ.get('FEISHU_APP_SECRET') and owner == r['ownerOpenId'] and len(r['allowedDestinations']) == 1)
    ok(context['environmentMatchesGuardRegistry'] is True and context['ownerMatchesProductionConfig'] is True and context['appFingerprint'] == hashlib.sha256(app.encode()).hexdigest())
    ok(r['hostId'] == 'gpu3-local-v1' and r['claudeServiceId'] == 'feishu-unified-claude-v1' and r['codexServiceId'] == 'feishu-unified-codex-v1' and r['codexEndpoint'] == 'codex-proxy://default')
    ok(shutil.which('codex') in ('/home/zhangzy/bin/codex', '/home/zhangzy/.local/bin/codex') and shutil.which('claude') is not None)
    agy = r.get('agy')
    allowed_providers = ('claude', 'codex', 'agy') if agy else ('claude', 'codex')
    for e in r['catalogSources']:
        q = Path(e['directory'])
        ok(e['provider'] in allowed_providers and not q.is_symlink() and q.resolve() == (STATE / 'catalog' / e['provider']).resolve() and q.is_dir() and not any(q.iterdir()))
    ok(len(r['catalogSources']) in (2, 3))
    proj_roots = r['allowedProjectRoots']
    ok(isinstance(proj_roots, list) and len(proj_roots) >= 1 and all(Path(x).is_dir() and Path(x).resolve().is_relative_to('/home/zhangzy') for x in proj_roots))
    paths = [r['coreDb'], r['channelDb'], r['artifactStatePath'], c['sdkDb']]
    usage_hub = r.get('usageHub')
    if isinstance(usage_hub, dict) and usage_hub.get('enabled') is True:
        usage_dest = usage_hub.get('destination')
        ok(isinstance(usage_dest, str) and bool(usage_dest.strip()) and usage_dest.strip() not in r['allowedDestinations'])
        usage_db = usage_hub.get('dbPath', str(STATE / 'usage-hub.sqlite'))
        ok(isinstance(usage_db, str) and bool(usage_db.strip()))
        paths.append(usage_db)
    resolved_paths = [Path(x).resolve() for x in paths]
    ok(len(set(resolved_paths)) == len(paths) and all(x.parent == STATE.resolve() for x in resolved_paths))
    ok(Path(r['claudeStateDir']).is_dir())
    allowed_output_bases = (Path('/home/zhangzy').resolve(), Path('/data/zhangzy').resolve(), Path('/ssd/zhangzy').resolve())
    ok(all(Path(x).is_dir() and any(Path(x).resolve().is_relative_to(base) for base in allowed_output_bases) for x in r['outputRoots']))
    if agy and agy.get('enabled', True):
        ok(agy.get('serviceId') == 'feishu-unified-agy-v1' and Path(agy.get('binPath', '/home/zhangzy/.gemini/bin/agy')).is_file())
        if agy.get('brainDir'):
            ok(Path(agy['brainDir']).is_dir())
    receipt = CONF / 'history-baseline-preparation.json'
    rs = receipt.lstat()
    ok(receipt.is_file() and not receipt.is_symlink() and rs.st_uid == os.getuid() and not rs.st_mode & 0o077)
    proof = json.loads(receipt.read_text())
    ok(proof.get('state') == 'completed' and type(proof.get('sessions')) is int and proof['sessions'] == 18 and type(proof.get('nonemptyTitles')) is int and proof['nonemptyTitles'] == 18 and type(proof.get('forbiddenSends')) is int and proof['forbiddenSends'] == 0 and type(proof.get('forbiddenModels')) is int and proof['forbiddenModels'] == 0)
    batches = proof.get('batches')
    ok(isinstance(batches, list) and len(batches) > 0 and isinstance(batches[-1], dict) and type(batches[-1].get('remaining')) is int and batches[-1]['remaining'] == 0)
    channel = Path(r['channelDb'])
    ok(channel.is_file() and not channel.is_symlink())
    db = sqlite3.connect(channel.resolve().as_uri() + '?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    try:
        ok(db.execute('SELECT COUNT(*) FROM channel_history_baselines').fetchone()[0] >= 18)
    finally:
        db.close()
    arc = r['historyArchive']
    a = Path(arc['root'])
    m = Path(arc['manifestPath'])
    ok(a.resolve() == (STATE / 'archive/20261116').resolve() and m.parent.resolve() == a.resolve() and m.is_file() and hashlib.sha256(m.read_bytes()).hexdigest() == arc['manifestSha256'] and (a / 'ledger.sqlite').is_file())
    ok(not RELEASE.is_symlink() and MAN.is_file() and hashlib.sha256(MAN.read_bytes()).hexdigest() == EXPECTED)
    names = set()
    for line in MAN.read_text().splitlines():
        digest, name = line.split('  ', 1)
        q = RELEASE / name
        ok(name.startswith('dist/') and '..' not in Path(name).parts and not q.is_symlink() and q.is_file() and q.resolve().is_relative_to(RELEASE.resolve()) and name not in names)
        names.add(name)
        ok(hashlib.sha256(q.read_bytes()).hexdigest() == digest)
    actual = {{str(p.relative_to(RELEASE)) for p in (RELEASE / 'dist').rglob('*') if p.is_file()}}
    ok(actual == names)
    ok(hashlib.sha256((RELEASE / 'scripts/unified-start.mjs').read_bytes()).hexdigest() == {start_script_sha!r})
    source_manifest = (RELEASE / 'source.sha256').read_text()
    ok(hashlib.sha256(source_manifest.encode()).hexdigest() == {source_manifest_sha!r})
    source_names = set()
    for line in source_manifest.splitlines():
        digest, name = line.split('  ', 1)
        q = RELEASE / name
        ok((name.startswith(('src/', 'scripts/', 'test/')) or name in ('package.json', 'package-lock.json', 'tsconfig.json')) and '..' not in Path(name).parts and not q.is_symlink() and q.is_file() and q.resolve().is_relative_to(RELEASE.resolve()) and name not in source_names)
        source_names.add(name)
        ok(hashlib.sha256(q.read_bytes()).hexdigest() == digest)
    source_actual = {{str(p.relative_to(RELEASE)) for root in ('src', 'scripts', 'test') for p in (RELEASE / root).rglob('*') if p.is_file()}} | {{'package.json', 'package-lock.json', 'tsconfig.json'}}
    ok(source_actual == source_names)
    for unit in ['feishu-claude-bridge.service', 'feishu-mobile-ui-20261116.service', 'feishu-mobile-ui-resume-20261116.service', 'feishu-m5-test.service']:
        q = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok(q.returncode in (3, 4))
    print('offline preflight passed')
except Exception as e:
    print(f'offline production preflight rejected: {{e}}', file=sys.stderr)
    sys.exit(1)
'''
preflight_path = staging / 'preflight.py'
preflight_path.write_text(preflight_code, encoding='utf-8')
preflight_path.chmod(0o755)

unit_content = f"""[Unit]
Description=Feishu unified Claude, Codex and Agy bridge
After=network-online.target
Wants=network-online.target
Conflicts=feishu-claude-bridge.service feishu-mobile-ui-20261116.service feishu-mobile-ui-resume-20261116.service feishu-m5-test.service
[Service]
Type=simple
WorkingDirectory={release_dir}
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--no-warnings
EnvironmentFile=/home/zhangzy/.config/feishu-claude-bridge/env
EnvironmentFile=/home/zhangzy/.config/feishu-claude-bridge/release-77310a6-features.env
Environment=PATH=/home/zhangzy/bin:/home/zhangzy/.local/bin:/home/zhangzy/.gemini/bin:/usr/local/node-v24.11.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/usr/bin/python3 {release_dir}/preflight.py
ExecStart=/usr/local/node-v24.11.1-linux-x64/bin/node --no-warnings {release_dir}/scripts/unified-start.mjs --run --config /home/zhangzy/.config/feishu-unified-bridge/config.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
SendSIGKILL=yes
UMask=0077
[Install]
WantedBy=default.target
"""
(staging / 'feishu-unified-production.service').write_text(unit_content, encoding='utf-8')

os.rename(staging, release_dir)

# 2. Update config.json cleanly (atomic replace with 0600 permissions)
orig_bytes = CONF_FILE.read_bytes()
cfg = json.loads(orig_bytes.decode('utf-8'))
rt = cfg['runtime']
rt['approvalPolicy'] = {'enabled': False}
agy = rt.setdefault('agy', {})
agy['sandbox'] = True
rt['allowedProjectRoots'] = [
    '/home/zhangzy/workspace',
    '/home/zhangzy/papers',
    '/home/zhangzy/research',
    '/home/zhangzy/scripts',
    '/home/zhangzy/courses',
    '/home/zhangzy',
]
rt['outputRoots'] = [
    '/home/zhangzy/workspace',
    '/home/zhangzy/papers',
    '/home/zhangzy/research',
    '/data/zhangzy/outputs',
    '/ssd/zhangzy/scratch',
]
rt['autoTakeControlOnInput'] = True
rt['autoResumeOnRestart'] = True
auto_mirror = rt.setdefault('autoMirror', {})
auto_mirror['backfillNativeIds'] = [
    {'provider': 'agy', 'nativeSessionId': '47bb480b-e598-4e78-80b4-3db372213afa', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': '8ab91e11-eaf9-4096-b29a-d296057018d9', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': '15bc9da6-0419-42ac-acb2-4d8479269a5a', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': '67786faa-02c1-4e62-bb8e-a5fbe7374c1b', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': 'a9ee387f-53d4-4038-9c04-43dd452f167b', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': 'b59ff0ab-8a4e-4eec-ad00-522df9899dfc', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': 'efe2c202-5b10-4532-b581-25bf54fa6db2', 'replayHistory': True},
    {'provider': 'agy', 'nativeSessionId': '189ba079-f241-49ab-8d45-613cc97fe41a', 'replayHistory': True},
]
agy['binPath'] = '/home/zhangzy/.gemini/bin/agy'
agy['summariesDbPath'] = '/home/zhangzy/.gemini/antigravity-cli/conversation_summaries.db'
agy['processPerSession'] = True
agy['defaultMode'] = 'auto'
agy['addDirs'] = ['/ssd/zhangzy', '/data/zhangzy']
agy['extraWriteRoots'] = [
    '/ssd/zhangzy/scratch',
    '/data/zhangzy/outputs',
    '/data/zhangzy/staging',
]
usage_hub = rt.setdefault('usageHub', {
    'enabled': True,
    'destination': 'oc_d7baeebbf218aebad70265c1b0f1a104',
})
if isinstance(usage_hub, dict):
    usage_hub.setdefault('dbPath', '/home/zhangzy/.local/state/feishu-unified-bridge/usage-hub.sqlite')
    usage_hub.setdefault('intervalMinutes', 60)

validate_agy_sandbox(rt)
tmp_cfg = None
try:
    with NamedTemporaryFile(mode='w', encoding='utf-8', dir=CONF_DIR,
                            prefix='.config.json.', suffix='.tmp', delete=False) as f:
        tmp_cfg = Path(f.name)
        os.fchmod(f.fileno(), 0o600)
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write('\n')
    # Validate the candidate offline before atomically replacing the live config.
    subprocess.run(
        ['/usr/local/node-v24.11.1-linux-x64/bin/node', '--no-warnings', str(release_dir / 'scripts/unified-start.mjs'), '--config', str(tmp_cfg)],
        check=True,
    )
    if CONF_FILE.read_bytes() != orig_bytes:
        raise RuntimeError('Live config changed during validation; refusing to replace it')
    os.replace(tmp_cfg, CONF_FILE)
    tmp_cfg = None
finally:
    if tmp_cfg is not None:
        tmp_cfg.unlink(missing_ok=True)

# 4. Update systemd user unit
tmp_unit = None
try:
    with NamedTemporaryFile(mode='w', encoding='utf-8', dir=UNIT_FILE.parent,
                            prefix=f'.{UNIT_FILE.name}.', delete=False) as f:
        tmp_unit = Path(f.name)
        os.fchmod(f.fileno(), 0o644)
        f.write(unit_content)
    os.replace(tmp_unit, UNIT_FILE)
finally:
    if tmp_unit is not None:
        tmp_unit.unlink(missing_ok=True)

prune_releases(release_dir, previous_unit, args.keep_releases)

print(f"DEPLOYED_RELEASE={release_name}")
print(f"RELEASE_DIR={release_dir}")
