#!/usr/bin/env python3
"""Build a sealed production release of feishu-agent-bridge and update config + systemd unit."""
import argparse
import errno
import fcntl
import hashlib
import inspect
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile

REPO = Path('/home/zhangzy/workspace/feishu-agent-bridge')
PRODUCTION_RELEASES_ROOT = Path('/home/zhangzy/.local/share/feishu-unified-bridge/releases')
RELEASES_ROOT = PRODUCTION_RELEASES_ROOT
CONF_DIR = Path('/home/zhangzy/.config/feishu-unified-bridge')
CONF_FILE = CONF_DIR / 'config.json'
UNIT_FILE = Path('/home/zhangzy/.config/systemd/user/feishu-unified-production.service')
PARENT_RELEASE = '607c887-agy-320eaa1fba6a'
CORE_DB = Path('/home/zhangzy/.local/state/feishu-unified-bridge/core.sqlite')
HOST_REGISTRY = CORE_DB.parent / 'session-host/registry.sqlite'
RUNTIME_DIR = Path(f'/run/user/{os.getuid()}/fsh')
DEPS_ROOT = RELEASES_ROOT.parent / 'deps'
HOST_ENTRY = 'dist/src/unified/session-host/host-main.js'
HOST_PROTOCOL = 1
DEV_GUARD = Path('/home/zhangzy/.codex/skills/sapphire-dev-workflow/scripts/dev_guard.py')


def _run_dev_guard_cmd(args: list[str], dev_guard: Path, label: str, timeout_s: int = 30) -> None:
    if not dev_guard.is_file():
        raise RuntimeError(f'{label}: dev_guard.py not found at {dev_guard} (pass --skip-guard to bypass)')
    try:
        proc = subprocess.run(
            [sys.executable, str(dev_guard), *args],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f'{label}: dev_guard.py timed out after {timeout_s}s') from exc
    if proc.returncode != 0:
        detail = (proc.stdout + proc.stderr).strip()
        raise RuntimeError(f'{label} failed:\n{detail}')


def run_pre_deploy_guard(repo: Path, dev_guard: Path = DEV_GUARD) -> None:
    _run_dev_guard_cmd(['release-check', str(repo), '--pre-deploy'], dev_guard, 'Pre-deploy dev_guard release-check')


def run_post_deploy_guard(repo: Path, unit_file: Path, dev_guard: Path = DEV_GUARD) -> None:
    _run_dev_guard_cmd(
        ['release-check', str(repo), '--systemd-unit', str(unit_file)],
        dev_guard,
        'Post-deploy dev_guard release-check',
    )


def _atomic_restore_bytes(path: Path, data: bytes, mode: int) -> None:
    tmp = None
    try:
        with NamedTemporaryFile(mode='wb', dir=path.parent, prefix=f'.{path.name}.rollback.', delete=False) as f:
            tmp = Path(f.name)
            os.fchmod(f.fileno(), mode)
            f.write(data)
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def check_active_work(core_db: Path) -> bool:
    try:
        core_db.stat()
    except FileNotFoundError:
        return False

    with closing(sqlite3.connect(core_db.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        tables = {name for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        session_join = ''
        interactive = ''
        if 'sessions' in tables:
            session_join = ' JOIN sessions s ON s.id=w.session_id'
            interactive = (" AND json_extract(s.value,'$.status') IS NOT 'read_only'"
                           " AND COALESCE(json_extract(s.value,'$.control.input')='available', 1)")
            if 'tracking_state' in tables:
                session_join += ' LEFT JOIN tracking_state t ON t.session_id=s.id'
                interactive += ' AND t.detached IS NOT 1'
        outbox = "SELECT operation_id, kind, state FROM outbox WHERE state IN ('pending','in_flight')"
        if 'steer_outbox_v1' in tables:
            outbox += " UNION ALL SELECT operation_id, kind, state FROM steer_outbox_v1 WHERE state IN ('pending','in_flight')"
        queries = (
            ('Turn', "SELECT w.session_id, w.id, json_extract(w.value,'$.status'), json_extract(w.value,'$.startedAt') "
                     f"FROM turns w{session_join} WHERE json_extract(w.value,'$.status') IN ('running','queued'){interactive}"),
            ('Outbox', outbox),
            ('Interaction', "SELECT w.id, w.session_id, json_extract(w.value,'$.kind') "
                            f"FROM interactions w{session_join} WHERE json_extract(w.value,'$.status') "
                            f"IN ('awaiting_answer','answer_pending_delivery'){interactive}"),
        )
        active = [(label, db.execute(sql).fetchall()) for label, sql in queries]

    if not any(rows for _, rows in active):
        return False
    print('Deploy blocked by active bridge work:', file=sys.stderr)
    for label, rows in active:
        for row in rows:
            print(f'  {label}: ' + ' / '.join(str(value) for value in row if value is not None), file=sys.stderr)
    print('Drain active work before deploying, or pass --force to bypass this check.', file=sys.stderr)
    return True


def active_host_work(core_db: Path):
    try:
        core_db.stat()
    except FileNotFoundError:
        return []
    with closing(sqlite3.connect(core_db.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        tables = {name for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        join = ' LEFT JOIN sessions s ON s.id=w.session_id' if 'sessions' in tables else ''
        native = "json_extract(s.value,'$.native')" if join else 'NULL'
        tracking = ' LEFT JOIN tracking_state t ON t.session_id=s.id' if join and 'tracking_state' in tables else ''
        interactive = (" AND json_extract(s.value,'$.status') IS NOT 'read_only'"
                       " AND COALESCE(json_extract(s.value,'$.control.input')='available',1)") if join else ''
        if tracking:
            interactive += ' AND t.detached IS NOT 1'
        work = db.execute(f"""
            SELECT 'Turn', w.id, w.session_id, json_extract(w.value,'$.status'), NULL, {native}, NULL, NULL
            FROM turns w{join}{tracking}
            WHERE json_extract(w.value,'$.status') IN ('running','queued'){interactive}
            UNION ALL
            SELECT 'Interaction', w.id, w.session_id, json_extract(w.value,'$.status'), NULL, {native}, NULL, NULL
            FROM interactions w{join}
            WHERE json_extract(w.value,'$.status') IN ('awaiting_answer','answer_pending_delivery')
        """).fetchall()
        for table in ('outbox', 'steer_outbox_v1'):
            if table == 'steer_outbox_v1' and table not in tables:
                continue
            columns = {column[1] for column in db.execute(f'PRAGMA table_info({table})')}
            context = 'w.context' if 'context' in columns else 'NULL'
            target = f"CASE WHEN json_valid({context}) THEN json_extract({context},'$.targetId') END"
            payload = 'w.payload' if 'payload' in columns else 'NULL'
            join = f' LEFT JOIN sessions s ON s.id={target}' if 'sessions' in tables else ''
            work.extend(db.execute(f"""
                SELECT ?, w.operation_id, {target}, w.state, w.kind, {native}, {payload}, {context}
                FROM {table} w{join} WHERE w.state IN ('pending','in_flight')
            """, (table,)))
    return work


@contextmanager
def registry_snapshot(path: Path, *, for_gc=False):
    try:
        entry = path.lstat()
    except FileNotFoundError:
        yield None
        return
    if not stat.S_ISREG(entry.st_mode):
        raise RuntimeError(f'Host registry is not a regular file: {path}')
    mode = 'rw' if for_gc else 'ro'
    with closing(sqlite3.connect(path.resolve().as_uri() + f'?mode={mode}', uri=True, timeout=1)) as db:
        db.row_factory = sqlite3.Row
        if not for_gc:
            db.execute('PRAGMA query_only=ON')
        # Stage 1 serializes pin registration with SQLite writers. Fence those
        # writers during deletion, without changing any registry data.
        db.execute('BEGIN IMMEDIATE' if for_gc else 'BEGIN')
        yield db


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip()) and '\0' not in value


def host_for_work(db, native, kind, operation_id, state, payload, context):
    ref_fields = ('provider', 'hostId', 'serviceId', 'nativeSessionId')
    ref = json.loads(native) if native is not None else None
    ctx = json.loads(context) if context is not None else None
    if kind is not None and (not isinstance(ctx, dict) or not nonempty_string(ctx.get('targetId'))
                             or ctx.get('operationId', operation_id) != operation_id):
        raise RuntimeError('unowned outbox item: missing or inconsistent operation context')
    select = """
        SELECT k.host_key, k.provider AS key_provider, k.host_id, k.service_id,
               k.native_session_id AS key_native_id, k.create_operation_id, k.identity_json, h.*
        FROM session_keys k LEFT JOIN host_instances h ON h.host_key=k.host_key
    """
    if native is not None and not isinstance(ref, dict):
        raise RuntimeError('invalid native session reference')
    complete_ref = isinstance(ref, dict) and all(nonempty_string(ref.get(field)) for field in ref_fields)
    if kind == 'createSession':
        request = json.loads(payload) if payload is not None else None
        provider = request.get('provider') if isinstance(request, dict) else None
        if (provider not in ('claude', 'codex', 'agy')
                or not nonempty_string(operation_id) or ctx.get('operationId') != operation_id
                or not nonempty_string(ctx.get('idempotencyKey'))):
            raise RuntimeError('unowned create: missing provider or durable operation identity')
        rows = db.execute(select + ' WHERE k.create_operation_id=?', (operation_id,)).fetchall() if db is not None else []
        if rows:
            key_ref = tuple(rows[0][column] for column in ('key_provider', 'host_id', 'service_id', 'key_native_id'))
            if key_ref[0] != provider or ref is not None and any(
                ref.get(field) is not None and ref[field] != value for field, value in zip(ref_fields, key_ref)
            ):
                raise RuntimeError('create reservation identity differs from outbox')
        no_native_ref = ref is None or ref.get('nativeSessionId') is None
        if state == 'pending' and no_native_ref and (
            not rows or rows[0]['instance_id'] is None and rows[0]['key_native_id'] is None
        ):
            # claimCreate changes the durable state before dispatching externally.
            return None
    elif complete_ref:
        rows = db.execute(select + """
            WHERE k.provider=? AND k.host_id=? AND k.service_id=? AND k.native_session_id=?
            AND h.state <> 'closed'
        """, tuple(ref[field] for field in ref_fields)).fetchall() if db is not None else []
    else:
        raise RuntimeError('unhosted work: missing or incomplete native session reference')
    if len(rows) != 1 or rows[0]['instance_id'] is None:
        raise RuntimeError('ambiguous host ownership' if len(rows) > 1 else 'no session host for active work')
    return rows[0]


def verify_host(db, host, runtime_dir: Path, test_override: bool, boot_id: str, kind) -> None:
    # Stage 1 publishes metadata after listen(), but keeps unbound creates
    # in "starting" until the runner supplies a native session ID.
    unbound_create = kind == 'createSession' and host['key_native_id'] is None and host['state'] == 'starting'
    if host['state'] not in ('ready', 'attached', 'detached', 'draining') and not unbound_create:
        raise RuntimeError(f"session host state {host['state']!r} cannot preserve active work")
    if host['protocol_version'] != HOST_PROTOCOL:
        raise RuntimeError(f"incompatible session host protocol {host['protocol_version']}")
    if host['provider'] != host['key_provider'] or host['native_session_id'] != host['key_native_id']:
        raise RuntimeError('host instance differs from its reserved identity')
    release = Path(host['release_dir'])
    if not release.is_absolute() or not release.is_dir():
        raise RuntimeError(f'missing session host release: {release}')
    pid = host['pid']
    if type(pid) is not int or pid <= 0 or host['boot_id'] != boot_id:
        raise RuntimeError('dead or stale session host process (PID or boot ID)')
    try:
        proc = Path(f'/proc/{pid}')
        proc_stat = (proc / 'stat').read_text()
        end = proc_stat.rindex(')')
        fields = proc_stat[end + 2:].split()
        if (len(fields) < 20 or fields[0] in ('Z', 'X', 'x') or fields[19] != host['start_ticks']
                or proc.stat().st_uid != os.getuid()):
            raise RuntimeError('dead or stale session host process (start ticks or owner)')
    except (FileNotFoundError, ProcessLookupError) as exc:
        raise RuntimeError(f'dead session host PID {pid}') from exc
    key = host['host_key']
    if not re.fullmatch(r'[0-9a-f]{32}', key):
        raise RuntimeError('invalid registry host key')
    identity = [host['key_provider'], host['host_id'], host['service_id']]
    if host['create_operation_id'] is None:
        identity.append(host['key_native_id'])
    else:
        identity = ['create', *identity, host['create_operation_id']]
    encoded = json.dumps(identity, ensure_ascii=False, separators=(',', ':'))
    if (json.loads(host['identity_json']) != identity
            or hashlib.sha256(encoded.encode()).hexdigest()[:32] != key):
        raise RuntimeError('session host reservation does not match its identity key')
    if not test_override:
        unit = f'feishu-session-host-{key}.service'
        cmdline = (proc / 'cmdline').read_bytes().split(b'\0')
        cgroups = (proc / 'cgroup').read_text().splitlines()
        if (host['unit_name'] != unit or os.fsencode(release / HOST_ENTRY) not in cmdline
                or not any(unit in Path(line.split(':', 2)[-1]).parts for line in cgroups)):
            raise RuntimeError(f'PID {pid} is not running the session host entry in {unit}')
    metadata_path = runtime_dir / f'{key}.json'
    try:
        with closing(os.fdopen(os.open(metadata_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb')) as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise RuntimeError('session host metadata is not a private regular file')
            data = file.read(64 * 1024 + 1)
            if len(data) > 64 * 1024:
                raise RuntimeError('session host metadata exceeds 64 KiB')
            metadata = json.loads(data)
    except FileNotFoundError:
        if not test_override or unbound_create:
            raise RuntimeError(f'missing session host metadata: {metadata_path}') from None
    else:
        fields = {'pid': 'pid', 'unit': 'unit_name', 'releaseDir': 'release_dir', 'protocolVersion': 'protocol_version',
                  'provider': 'provider', 'sessionId': 'native_session_id', 'hostId': 'host_id', 'serviceId': 'service_id',
                  'instanceId': 'instance_id', 'bootId': 'boot_id', 'startTicks': 'start_ticks'}
        if (not isinstance(metadata, dict) or type(metadata.get('protocolVersion')) is not int
                or type(metadata.get('pid')) is not int
                or any(name not in metadata or metadata[name] != host[column] for name, column in fields.items())):
            raise RuntimeError('live session host metadata differs from registry')
    # The same release can be independently protected by a running process or unit.
    if not db.execute('SELECT 1 FROM release_pins WHERE host_key=? AND release_dir=?',
                      (key, str(release))).fetchone():
        protected = unit_releases(read_unit()) | running_releases() | systemd_host_releases()
        if release.resolve() not in protected:
            raise RuntimeError(f'session host release is not pinned or protected: {release}')


def check_seamless_work(core_db: Path, host_registry: Path, runtime_dir: Path, test_override: bool) -> bool:
    work = active_host_work(core_db)
    if not work:
        return False
    blocked = []
    labels = [' / '.join(str(value) for value in item[:5] if value is not None) for item in work]
    try:
        with registry_snapshot(host_registry) as db:
            boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            for label, (_, item_id, _, state, kind, native, payload, context) in zip(labels, work):
                try:
                    host = host_for_work(db, native, kind, item_id, state, payload, context)
                    if host is not None:
                        verify_host(db, host, runtime_dir, test_override, boot_id, kind)
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
                    blocked.append((label, str(exc)))
    except (OSError, sqlite3.Error, RuntimeError) as exc:
        blocked = [(label, f'cannot reconcile against host registry {host_registry}: {exc}') for label in labels]
    if blocked:
        print('Seamless deploy blocked by active bridge work:', file=sys.stderr)
        for label, reason in blocked:
            print(f'  {label}: {reason}', file=sys.stderr)
    return bool(blocked)


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


def running_releases(proc_root: Path = Path('/proc')) -> set[Path]:
    protected = set()
    for proc in proc_root.iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            argv = [os.fsdecode(arg) for arg in (proc / 'cmdline').read_bytes().split(b'\0') if arg]
            launchers = [Path(arg) for arg in argv if Path(arg).name in ('unified-start.mjs', 'host-main.js')]
            if argv and Path(argv[0]).name == 'feishu-unified-bridge':
                launchers.append(Path(argv[0]))
            paths = [path for path in launchers if path.is_absolute()]
            try:
                cwd = Path(str((proc / 'cwd').readlink()).removesuffix(' (deleted)'))
            except FileNotFoundError:
                # Retain absolute launch paths even if the process just exited.
                pass
            else:
                paths.extend([cwd, *(cwd / path for path in launchers if not path.is_absolute())])
            protected.update(release for p in paths if (release := release_from_path(p)) is not None)
        except (FileNotFoundError, ProcessLookupError):
            # The process can disappear between directory enumeration and the reads.
            continue
    return protected


def read_unit() -> str:
    try:
        return UNIT_FILE.read_text(encoding='utf-8')
    except FileNotFoundError:
        return ''


def systemd_host_releases() -> set[Path]:
    def run(*args):
        return subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True, timeout=5)

    listing = run('list-units', '--no-legend', '--no-pager', '--plain',
                  '--state=active,activating,reloading,deactivating', 'feishu-session-host-*.service')
    if listing.returncode:
        if 'Failed to connect to bus:' in listing.stderr or 'Failed to connect to user scope bus' in listing.stderr:
            return set()
        raise RuntimeError(f'Cannot list systemd session hosts: {listing.stderr.strip()}')
    protected = set()
    for line in listing.stdout.splitlines():
        fields = line.split()
        if not fields:
            continue
        unit = fields[0]
        if not re.fullmatch(r'feishu-session-host-[\w-]+\.service', unit):
            raise RuntimeError(f'Unexpected session-host unit in systemd listing: {unit}')
        details = run('show', '--property=ExecStart,WorkingDirectory', unit)
        if details.returncode:
            raise RuntimeError(f'Cannot inspect systemd session host {unit}: {details.stderr.strip()}')
        protected.update(unit_releases(details.stdout))
    return protected


def collect_protected_releases(release_dir: Path, previous_unit: str, registries) -> set[Path]:
    protected = unit_releases(previous_unit) | unit_releases(read_unit()) | {release_dir.resolve()}
    for registry in registries:
        if registry is None:
            continue
        for row in registry.execute("""SELECT release_dir FROM release_pins
            UNION SELECT release_dir FROM host_instances WHERE state <> 'closed'"""):
            path = Path(row['release_dir'])
            if not path.is_absolute():
                raise RuntimeError(f'Invalid session host release path: {path}')
            if (release := release_from_path(path)) is not None:
                protected.add(release)
    return protected | systemd_host_releases() | running_releases()


def unused_dependencies(remaining) -> list[Path]:
    try:
        deps = list(DEPS_ROOT.iterdir())
    except FileNotFoundError:
        return []
    root = DEPS_ROOT.resolve()
    referenced = set()
    for release in remaining:
        paths = [(release / 'node_modules').resolve()]
        generation = release / 'generation.json'
        try:
            metadata = json.loads(generation.read_text(encoding='utf-8'))
        except FileNotFoundError:
            metadata = {}
        if not isinstance(metadata, dict):
            raise RuntimeError(f'Invalid release generation: {generation}')
        if 'depsDir' in metadata:
            if not nonempty_string(metadata['depsDir']) or not Path(metadata['depsDir']).is_absolute():
                raise RuntimeError(f'Invalid dependency path in {generation}')
            paths.append(Path(metadata['depsDir']).resolve())
        if 'depsSha256' in metadata:
            digest = metadata['depsSha256']
            if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{16}', digest):
                raise RuntimeError(f'Invalid dependency digest in {generation}')
            referenced.add(root / digest)
        for path in paths:
            if path.is_relative_to(root) and path != root:
                referenced.add(root / path.relative_to(root).parts[0])
    return [p for p in deps if re.fullmatch(r'[0-9a-f]{16}', p.name)
            and not p.is_symlink() and p.is_dir() and p.resolve() not in referenced]


@contextmanager
def release_gc_lock(deploy_lock_held: bool):
    if deploy_lock_held:
        yield
        return
    fd = os.open(RELEASES_ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def prune_releases(release_dir: Path, previous_unit: str, keep: int, host_registry: Path = HOST_REGISTRY,
                   *, deploy_lock_held: bool = False) -> None:
    release_pattern = re.compile(r'[0-9a-f]{7,40}(?:-[a-zA-Z0-9-]+)?')
    try:
        with release_gc_lock(deploy_lock_held), ExitStack() as snapshots:
            paths = [host_registry]
            if RELEASES_ROOT.resolve() == PRODUCTION_RELEASES_ROOT.resolve() and host_registry.resolve() != HOST_REGISTRY.resolve():
                paths.insert(0, HOST_REGISTRY)
            registries = [snapshots.enter_context(registry_snapshot(path, for_gc=True)) for path in paths]
            protected = collect_protected_releases(release_dir, previous_unit, registries)
            entries = [p for p in RELEASES_ROOT.resolve().iterdir() if p.is_dir()]
            candidates = sorted(
                (p for p in entries if release_pattern.fullmatch(p.name) and not p.is_symlink()),
                key=lambda p: (p.stat().st_mtime_ns, p.name),
                reverse=True,
            )
            # The new release is retained separately from the requested old releases.
            newest_old = [p for p in candidates if p != release_dir.resolve()][:keep]
            remove = set(candidates) - protected - set(newest_old)
            deps = unused_dependencies(p for p in entries if p not in remove)
            for path, registry in zip(paths, registries):
                if registry is None and os.path.lexists(path):
                    raise RuntimeError(f'Host registry appeared during release GC: {path}')
            for path in candidates:
                if path in remove:
                    shutil.rmtree(path)
                    print(f'PRUNED_RELEASE={path.name}')
            for path in deps:
                shutil.rmtree(path)
                print(f'PRUNED_DEPS={path.name}')
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as exc:
        message = f'Release GC stopped: cannot verify release protection or complete pruning: {exc}'
        print(message, file=sys.stderr)
        raise RuntimeError(message) from exc


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


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def build_manifest(base: Path, files: list[Path]) -> str:
    lines = []
    for p in sorted(files, key=lambda x: str(x.relative_to(base))):
        lines.append(f"{sha256_file(p)}  {p.relative_to(base)}")
    return "\n".join(lines) + "\n"


def stage_dependencies(source: Path, deps_sha: str) -> Path:
    def link_or_copy(src, dst):
        try:
            os.link(src, dst)
        except OSError as exc:
            if exc.errno not in (errno.EXDEV, errno.EPERM, errno.EOPNOTSUPP, errno.EMLINK):
                raise
            shutil.copy2(src, dst)

    DEPS_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = DEPS_ROOT / deps_sha
    modules = destination / 'node_modules'
    if DEPS_ROOT.is_symlink() or destination.is_symlink() or modules.is_symlink():
        raise RuntimeError(f'Invalid dependency cache: {modules}')
    if not modules.exists():
        staging = DEPS_ROOT / f'.staging-{deps_sha}-{os.getpid()}'
        staging.mkdir(mode=0o700)
        try:
            copied = staging / 'node_modules'
            shutil.copytree(source, copied, symlinks=True, copy_function=link_or_copy)
            source_root = source.resolve()
            # npm's relative bin links stay inside the snapshot. Rebase absolute
            # internal links and reject links that would depend on the checkout.
            for parent, directories, files in os.walk(copied):
                for name in directories + files:
                    link = Path(parent, name)
                    if not link.is_symlink():
                        continue
                    target = link.readlink()
                    original = (source_root / link.relative_to(copied).parent / target).resolve()
                    if not original.is_relative_to(source_root):
                        raise RuntimeError(f'Dependency symlink leaves node_modules: {link.relative_to(copied)}')
                    relative = os.path.relpath(copied / original.relative_to(source_root), link.parent)
                    if relative != str(target):
                        link.unlink()
                        link.symlink_to(relative)
            os.rename(staging, destination)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    if not modules.is_dir():
        raise RuntimeError(f'Invalid dependency cache: {modules}')
    return destination


def active_work_blocked(args):
    if args.seamless:
        test_override = (args.check_active_only and args.core_db.resolve() != CORE_DB.resolve()
                         and args.runtime_dir.resolve() != RUNTIME_DIR.resolve()
                         and args.host_registry.resolve() != HOST_REGISTRY.resolve())
        return check_seamless_work(args.core_db, args.host_registry, args.runtime_dir, test_override)
    return not args.force and check_active_work(args.core_db)


def stage_release(staging: Path, commit: str, branch: str):
    for d in ('dist', 'scripts', 'src', 'test'):
        shutil.copytree(REPO / d, staging / d, symlinks=False)
    for f in ('package.json', 'package-lock.json', 'tsconfig.json'):
        shutil.copy2(REPO / f, staging / f)
    deps_sha = sha256_file(staging / 'package-lock.json')[:16]
    deps_dir = stage_dependencies(REPO / 'node_modules', deps_sha)
    (staging / 'node_modules').symlink_to(deps_dir / 'node_modules', target_is_directory=True)

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
        "sessionHostProtocolVersion": HOST_PROTOCOL,
        "depsSha256": deps_sha,
        "depsDir": str(deps_dir),
    }
    (staging / 'generation.json').write_text(json.dumps(generation, indent=2) + "\n", encoding='utf-8')

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
ExecStart=/usr/local/node-v24.11.1-linux-x64/bin/node --no-warnings {release_dir}/scripts/unified-start.mjs --run --config {CONF_FILE}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
SendSIGKILL=yes
UMask=0077
[Install]
WantedBy=default.target
"""
    (staging / 'feishu-unified-production.service').write_text(unit_content, encoding='utf-8')

    preflight_code = f'''#!/usr/bin/env python3
"""Offline launch preflight. No network, native process, or database writes."""
import argparse, hashlib, json, os, shutil, sqlite3, subprocess, sys
from pathlib import Path
RELEASE = Path(__file__).absolute().parent
CONF = Path({str(CONF_DIR)!r})
STATE = Path('/home/zhangzy/.local/state/feishu-unified-bridge')
MAN = RELEASE / 'dist.sha256'
EXPECTED = {dist_manifest_sha!r}
{inspect.getsource(validate_agy_sandbox)}
def ok(v, message='production invariant failed'):
    if not v:
        raise RuntimeError(message)

def validate_manifests(r):
    validate_agy_sandbox(r)
    agy = r['agy']
    ok(r['approvalPolicy']['enabled'] is False and agy['sandbox'] is True
       and agy['binPath'] == '/home/zhangzy/.gemini/bin/agy' and agy['defaultMode'] == 'auto'
       and r['autoTakeControlOnInput'] is True and r['autoResumeOnRestart'] is True,
       'production runtime settings differ from the required defaults')
    unit_file = RELEASE / 'feishu-unified-production.service'
    unit = unit_file.read_text()
    ok(not unit_file.is_symlink() and hashlib.sha256(unit.encode()).hexdigest()
       == {hashlib.sha256(unit_content.encode()).hexdigest()!r}, 'production unit digest mismatch')
    ok([line for line in unit.splitlines() if line.startswith('Environment=NODE_OPTIONS=')]
       == ['Environment=NODE_OPTIONS=--no-warnings'], 'invalid production NODE_OPTIONS')
    ok(not RELEASE.is_symlink() and MAN.is_file() and hashlib.sha256(MAN.read_bytes()).hexdigest() == EXPECTED, 'dist manifest digest mismatch')
    names = set()
    for line in MAN.read_text().splitlines():
        digest, name = line.split('  ', 1)
        q = RELEASE / name
        ok(name.startswith('dist/') and '..' not in Path(name).parts and not q.is_symlink() and q.is_file() and q.resolve().is_relative_to(RELEASE.resolve()) and name not in names)
        names.add(name)
        ok(hashlib.sha256(q.read_bytes()).hexdigest() == digest, f'digest mismatch: {{name}}')
    host_entry = {HOST_ENTRY!r}
    ok(host_entry in names and (RELEASE / host_entry).is_file() and not (RELEASE / host_entry).is_symlink(),
       'session host entry point missing from dist manifest')
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
        ok(hashlib.sha256(q.read_bytes()).hexdigest() == digest, f'digest mismatch: {{name}}')
    source_actual = {{str(p.relative_to(RELEASE)) for root in ('src', 'scripts', 'test') for p in (RELEASE / root).rglob('*') if p.is_file()}} | {{'package.json', 'package-lock.json', 'tsconfig.json'}}
    ok(source_actual == source_names)
    generation = json.loads((RELEASE / 'generation.json').read_text())
    ok(type(generation['sessionHostProtocolVersion']) is int
       and generation['sessionHostProtocolVersion'] == {HOST_PROTOCOL!r}, 'invalid session host protocol version')
    deps_sha = hashlib.sha256((RELEASE / 'package-lock.json').read_bytes()).hexdigest()[:16]
    deps_root = RELEASE.parent.parent / 'deps'
    deps_dir = deps_root / deps_sha
    modules = deps_dir / 'node_modules'
    link = RELEASE / 'node_modules'
    ok(generation['depsSha256'] == deps_sha and Path(generation['depsDir']) == deps_dir
       and not deps_root.is_symlink() and not deps_dir.is_symlink() and not modules.is_symlink()
       and modules.is_dir() and link.is_symlink() and link.resolve() == modules.resolve(),
       'invalid immutable node_modules snapshot')

def validate_production(c, r):
    ok(RELEASE == Path({str(release_dir)!r}), 'unexpected production release path')
    ok(os.environ.get('NODE_OPTIONS') == '--no-warnings', 'invalid effective NODE_OPTIONS')
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
    for unit in ['feishu-claude-bridge.service', 'feishu-mobile-ui-20261116.service', 'feishu-mobile-ui-resume-20261116.service', 'feishu-m5-test.service']:
        q = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok(q.returncode in (3, 4))

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--manifest-only', action='store_true')
parser.add_argument('--config', type=Path, help='Candidate config for manifest-only validation')
args = parser.parse_args()
if args.config is not None and not args.manifest_only:
    parser.error('--config requires --manifest-only')
try:
    p = args.config or CONF / 'config.json'
    s = p.lstat()
    ok(p.is_file() and not p.is_symlink() and s.st_uid == os.getuid() and not s.st_mode & 0o077)
    c = json.loads(p.read_text())
    r = c['runtime']
    validate_manifests(r)
    if not args.manifest_only:
        validate_production(c, r)
    print('offline preflight passed')
except Exception as e:
    print(f'offline production preflight rejected: {{e}}', file=sys.stderr)
    sys.exit(1)
'''
    preflight_path = staging / 'preflight.py'
    preflight_path.write_text(preflight_code, encoding='utf-8')
    preflight_path.chmod(0o755)

    return release_name, release_dir, unit_content


def candidate_config(orig_bytes: bytes):
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

    return cfg


def deploy_release(args, staging: Path, commit: str, branch: str) -> int:
    previous_unit = read_unit()
    release_name, release_dir, unit_content = stage_release(staging, commit, branch)
    orig_bytes = CONF_FILE.read_bytes()
    cfg = candidate_config(orig_bytes)
    validate_agy_sandbox(cfg['runtime'])
    tmp_cfg = None
    tmp_unit = None
    try:
        with NamedTemporaryFile(mode='w', encoding='utf-8', dir=CONF_DIR,
                                prefix='.config.json.', suffix='.tmp', delete=False) as f:
            tmp_cfg = Path(f.name)
            os.fchmod(f.fileno(), 0o600)
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write('\n')
        # Inspect the packaged files and candidate config without production credentials.
        subprocess.run([sys.executable, str(staging / 'preflight.py'), '--manifest-only', '--config', str(tmp_cfg)],
                       check=True)
        subprocess.run(
            ['/usr/local/node-v24.11.1-linux-x64/bin/node', '--no-warnings', str(staging / 'scripts/unified-start.mjs'), '--config', str(tmp_cfg)],
            check=True,
        )
        os.rename(staging, release_dir)
        if not args.skip_guard:
            try:
                run_post_deploy_guard(REPO, release_dir / 'feishu-unified-production.service')
            except RuntimeError as exc:
                print(str(exc), file=sys.stderr)
                return 2
        with NamedTemporaryFile(mode='w', encoding='utf-8', dir=UNIT_FILE.parent,
                                prefix=f'.{UNIT_FILE.name}.', delete=False) as f:
            tmp_unit = Path(f.name)
            os.fchmod(f.fileno(), 0o644)
            f.write(unit_content)
        if args.seamless and active_work_blocked(args):
            return 2
        if CONF_FILE.read_bytes() != orig_bytes or read_unit() != previous_unit:
            raise RuntimeError('Live config or unit changed during validation; refusing to replace them')
        os.replace(tmp_cfg, CONF_FILE)
        try:
            os.replace(tmp_unit, UNIT_FILE)
        except OSError:
            _atomic_restore_bytes(CONF_FILE, orig_bytes, 0o600)
            raise
    finally:
        for path in (tmp_cfg, tmp_unit):
            if path is not None:
                path.unlink(missing_ok=True)

    if not args.skip_guard:
        try:
            run_post_deploy_guard(REPO, UNIT_FILE)
        except RuntimeError as exc:
            # Roll back live unit & config atomically before pruning any previous releases
            if previous_unit:
                _atomic_restore_bytes(UNIT_FILE, previous_unit.encode('utf-8'), 0o644)
            else:
                UNIT_FILE.unlink(missing_ok=True)
            _atomic_restore_bytes(CONF_FILE, orig_bytes, 0o600)
            print(f'{exc}\nRolled back live unit and config cleanly.', file=sys.stderr)
            return 2

    try:
        prune_releases(release_dir, previous_unit, args.keep_releases, args.host_registry, deploy_lock_held=True)
    except RuntimeError:
        print(f'Unit and config were published for {release_dir}; release GC failed.', file=sys.stderr)
        return 1

    print(f"DEPLOYED_RELEASE={release_name}")
    print(f"RELEASE_DIR={release_dir}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    active_gate = parser.add_mutually_exclusive_group()
    active_gate.add_argument('--force', action='store_true', help='Bypass the active-work check')
    active_gate.add_argument('--seamless', action='store_true', help='Allow active work backed by compatible live session hosts')
    parser.add_argument('--core-db', type=Path, default=CORE_DB, help='Path to the bridge core SQLite database')
    parser.add_argument('--host-registry', type=Path, default=HOST_REGISTRY, help='Path to the session host registry')
    parser.add_argument('--runtime-dir', type=Path, default=RUNTIME_DIR, help='Directory containing live session host metadata')
    parser.add_argument('--keep-releases', type=int, default=8, help='Number of newest old releases to keep (default: 8)')
    parser.add_argument('--check-active-only', action='store_true', help='Check for active work without deploying')
    parser.add_argument('--skip-guard', action='store_true', help='Skip dev_guard.py release-check (emergency/test only)')
    args = parser.parse_args(argv)
    if args.keep_releases < 0:
        parser.error('--keep-releases must be non-negative')

    try:
        if active_work_blocked(args):
            return 2
    except (OSError, sqlite3.Error) as exc:
        print(f'Cannot check active bridge work in {args.core_db}: {exc}', file=sys.stderr)
        return 1
    if args.check_active_only:
        return 0

    RELEASES_ROOT.mkdir(parents=True, exist_ok=True)
    # Hold through staging, unit publication and GC so deploys cannot prune each other's releases.
    deploy_lock = os.open(RELEASES_ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            fcntl.flock(deploy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another production deployment is already in progress.', file=sys.stderr)
            return 1
        if not args.skip_guard:
            try:
                run_pre_deploy_guard(REPO)
            except RuntimeError as exc:
                print(str(exc), file=sys.stderr)
                return 2
        commit = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', '--short', 'HEAD'], text=True).strip()
        branch = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', '--abbrev-ref', 'HEAD'], text=True).strip()

        staging = RELEASES_ROOT / f'.staging-{commit}-{os.getpid()}'
        staging.mkdir(mode=0o700)
        try:
            return deploy_release(args, staging, commit, branch)
        except (OSError, sqlite3.Error, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            print(f'Production deployment failed: {exc}', file=sys.stderr)
            return 1
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    finally:
        os.close(deploy_lock)


if __name__ == '__main__':
    sys.exit(main())
