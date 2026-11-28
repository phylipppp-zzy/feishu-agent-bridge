import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import type { Socket } from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_PAYLOAD_BYTES = 32 * MAX_FRAME_BYTES;
const CHUNK_BYTES = 192 * 1024;
const HEX_32 = /^[0-9a-f]{64}$/;
const KEY = /^[0-9a-f]{32}$/;

export const errorCodes = [
  'fenced', 'version_mismatch', 'snapshot_required', 'identity_mismatch', 'busy',
  'outcome_unknown', 'unauthorized', 'invalid_request', 'temporarily_unavailable',
] as const;
export type ErrorCode = typeof errorCodes[number];
export class HostError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'HostError';
  }
}

export type HostRef = readonly [provider: string, hostId: string, serviceId: string, nativeSessionId: string];
export type CreateIdentity = readonly ['create', provider: string, hostId: string, serviceId: string, operationId: string];
export type HostIdentity = HostRef | CreateIdentity;
export type Fields = Record<string, unknown>;

export function object(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostError('invalid_request', 'expected an object');
  }
  return value as Fields;
}

export function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096 || value.includes('\0')) {
    throw new HostError('invalid_request', 'invalid ' + field);
  }
  return value;
}

export function counter(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new HostError('invalid_request', 'invalid ' + field);
  }
  return value;
}

export function hex(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new HostError('invalid_request', 'invalid ' + field);
  }
  return value;
}

export function parseRef(value: unknown): HostRef {
  if (!Array.isArray(value) || value.length !== 4) throw new HostError('invalid_request', 'invalid ref');
  return [
    string(value[0], 'provider'), string(value[1], 'hostId'),
    string(value[2], 'serviceId'), string(value[3], 'nativeSessionId'),
  ];
}

export function parseIdentity(value: unknown): HostIdentity {
  if (Array.isArray(value) && value.length === 5 && value[0] === 'create') {
    return [
      'create', string(value[1], 'provider'), string(value[2], 'hostId'),
      string(value[3], 'serviceId'), string(value[4], 'operationId'),
    ];
  }
  return parseRef(value);
}

export function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new HostError('invalid_request', 'value is not JSON serializable');
  return encoded;
}

export function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sessionKey(identity: HostIdentity): string {
  return sha256(json(parseIdentity(identity))).slice(0, 32);
}

export function sameRef(a: HostRef | null, b: HostRef | null): boolean {
  return json(a) === json(b);
}

export function nonce(): string {
  return randomBytes(32).toString('hex');
}

export interface Challenge {
  key: string;
  instanceId: string;
  clientId: string;
  bridgeEpoch: number;
  clientNonce: string;
  hostNonce: string;
}

export function handshakeMac(secret: Uint8Array, role: 'host' | 'client', c: Challenge): string {
  return createHmac('sha256', secret).update(json([
    role, PROTOCOL_VERSION, c.key, c.instanceId, c.clientId, c.bridgeEpoch, c.clientNonce, c.hostNonce,
  ])).digest('hex');
}

export function verifyMac(expected: string, received: unknown): boolean {
  return typeof received === 'string' && HEX_32.test(received)
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

export function currentUid(): number {
  if (!process.getuid) throw new Error('session hosts require a Unix UID');
  return process.getuid();
}

export function defaultRuntimeDir(): string {
  return '/run/user/' + currentUid() + '/fsh';
}

export interface RuntimePaths {
  dir: string;
  socket: string;
  lock: string;
  metadata: string;
  secret: string;
}
export function runtimePaths(runtimeDir: string, key: string): RuntimePaths {
  if (!KEY.test(key)) throw new HostError('invalid_request', 'invalid host key');
  const dir = resolve(runtimeDir);
  const socket = join(dir, key + '.sock');
  if (Buffer.byteLength(socket, 'utf8') > 90) {
    throw new HostError('invalid_request', 'socket path exceeds 90 UTF-8 bytes');
  }
  return { dir, socket, lock: join(dir, key + '.lock'), metadata: join(dir, key + '.json'), secret: join(dir, key + '.key') };
}

export function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function directoryPath(path: string, create: boolean): string {
  if (path.split(sep).includes('..')) throw new HostError('unauthorized', 'parent path components are disallowed');
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!create || !errno(error, 'ENOENT')) throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!errno(mkdirError, 'EEXIST')) throw mkdirError;
      }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory()) throw new HostError('unauthorized', 'unsafe directory component');
  }
  return absolute;
}

export function privateDirectory(path: string, create = false): string {
  const absolute = directoryPath(path, create);
  const stat = lstatSync(absolute);
  if (stat.uid !== currentUid() || (stat.mode & 0o7777) !== 0o700) {
    throw new HostError('unauthorized', 'private directory must be owned by current UID with mode 0700');
  }
  return absolute;
}

function validatePrivateStat(stat: Stats, kind: 'file' | 'socket'): void {
  if ((kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isSocket())
      || stat.uid !== currentUid() || (stat.mode & 0o7777) !== 0o600) {
    throw new HostError('unauthorized', 'unsafe private ' + kind + ' owner, type or permissions');
  }
}

export function checkPrivateSocket(path: string): void {
  validatePrivateStat(lstatSync(path), 'socket');
}

export function openPrivateFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    validatePrivateStat(fstatSync(fd), 'file');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readPrivateFile(path: string, maxBytes = 64 * 1024): Buffer {
  directoryPath(dirname(path), false);
  const fd = openPrivateFile(path, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size > maxBytes) throw new HostError('invalid_request', 'private file too large');
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) throw new HostError('invalid_request', 'private file too large');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writePrivateAtomic(path: string, contents: string): void {
  const temp = path + '.' + randomUUID();
  const fd = openPrivateFile(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    writeFileSync(fd, contents);
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  } finally {
    closeSync(fd);
  }
}

export function readSecret(path: string): Buffer {
  return Buffer.from(hex(readPrivateFile(path, 64).toString('latin1'), 'key file'), 'hex');
}

export interface HostMetadata {
  pid: number;
  unit: string | null;
  releaseDir: string;
  protocolVersion: 1;
  provider: string;
  sessionId: string | null;
  hostId: string;
  serviceId: string;
  instanceId: string;
  startedAt: string;
  bootId: string;
  startTicks: string;
  keyId: string;
}

export function readMetadata(path: string): HostMetadata {
  const data = object(parseJson(decodeUtf8(readPrivateFile(path))));
  const metadata: HostMetadata = {
    pid: counter(data.pid, 'pid', 1),
    unit: data.unit === null ? null : string(data.unit, 'unit'),
    releaseDir: string(data.releaseDir, 'releaseDir'),
    protocolVersion: PROTOCOL_VERSION,
    provider: string(data.provider, 'provider'),
    sessionId: data.sessionId === null ? null : string(data.sessionId, 'sessionId'),
    hostId: string(data.hostId, 'hostId'),
    serviceId: string(data.serviceId, 'serviceId'),
    instanceId: string(data.instanceId, 'instanceId'),
    startedAt: string(data.startedAt, 'startedAt'),
    bootId: string(data.bootId, 'bootId'),
    startTicks: string(data.startTicks, 'startTicks'),
    keyId: hex(data.keyId, 'keyId'),
  };
  if (data.protocolVersion !== PROTOCOL_VERSION) throw new HostError('version_mismatch');
  if (Object.keys(data).length !== Object.keys(metadata).length || !isAbsolute(metadata.releaseDir)
      || !Number.isFinite(Date.parse(metadata.startedAt)) || !/^\d+$/.test(metadata.startTicks)
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(metadata.bootId)
      || (metadata.unit !== null && !/^feishu-session-host-[0-9a-f]{32}\.service$/.test(metadata.unit))) {
    throw new HostError('invalid_request', 'invalid host metadata');
  }
  return metadata;
}

export function metadataRef(metadata: HostMetadata): HostRef | null {
  return metadata.sessionId === null
    ? null : [metadata.provider, metadata.hostId, metadata.serviceId, metadata.sessionId];
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HostError('invalid_request', 'invalid UTF-8');
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  const decoded = decodeUtf8(bytes);
  try {
    return parseJson(decoded);
  } catch {
    throw new HostError('invalid_request', 'malformed JSON');
  }
}

export interface PayloadChunk {
  chunkId: string;
  index: number;
  total: number;
  sha256: string;
  byteLength: number;
  dataBase64: string;
}

export function chunkPayload(bytes: Uint8Array, chunkId = randomUUID()): PayloadChunk[] {
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new HostError('invalid_request', 'payload exceeds chunk limit');
  const total = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  const digest = sha256(bytes);
  return Array.from({ length: total }, (_, index) => ({
    chunkId, index, total, sha256: digest, byteLength: bytes.byteLength,
    dataBase64: Buffer.from(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).toString('base64'),
  }));
}

export class ChunkAssembler {
  private header?: PayloadChunk;
  private readonly parts: Buffer[] = [];

  push(value: unknown): Buffer | undefined {
    const c = object(value);
    const byteLength = counter(c.byteLength, 'byteLength');
    const total = counter(c.total, 'total', 1);
    const index = counter(c.index, 'index');
    const digest = hex(c.sha256, 'sha256');
    const chunkId = string(c.chunkId, 'chunkId');
    const dataBase64 = c.dataBase64;
    if (byteLength > MAX_PAYLOAD_BYTES || total !== Math.max(1, Math.ceil(byteLength / CHUNK_BYTES))
        || index >= total || index !== this.parts.length || typeof dataBase64 !== 'string'
        || dataBase64.length > Math.ceil(CHUNK_BYTES / 3) * 4
        || (this.header && (this.header.chunkId !== chunkId || this.header.total !== total
          || this.header.sha256 !== digest || this.header.byteLength !== byteLength))) {
      throw new HostError('invalid_request', 'invalid chunk sequence or header');
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.toString('base64') !== dataBase64 || bytes.length !== Math.min(CHUNK_BYTES, byteLength - index * CHUNK_BYTES)) {
      throw new HostError('invalid_request', 'invalid chunk encoding or length');
    }
    this.header ??= { chunkId, index, total, sha256: digest, byteLength, dataBase64 };
    this.parts.push(bytes);
    if (this.parts.length < total) return undefined;
    const joined = Buffer.concat(this.parts);
    if (joined.length !== byteLength || sha256(joined) !== digest) {
      throw new HostError('invalid_request', 'chunk payload integrity failure');
    }
    return joined;
  }
}

export function joinChunks(chunks: readonly unknown[]): Buffer {
  const assembler = new ChunkAssembler();
  let result: Buffer | undefined;
  for (const chunk of chunks) result = assembler.push(chunk);
  if (!result) throw new HostError('invalid_request', 'incomplete chunk payload');
  return result;
}

export function decodeChunkedJson(bytes: Uint8Array): unknown {
  return decodeJson(bytes);
}

export function commandDigest(kind: string, args: unknown, attachment: Uint8Array | null = null): string {
  return sha256(json([kind, args, attachment && sha256(attachment)]));
}

export interface SnapshotPage {
  snapshotId: string;
  barrierSeq: number;
  page: number;
  totalPages: number;
  items: unknown[];
  digest?: string;
}

export function snapshotDigest(items: Iterable<unknown>): string {
  const hash = createHash('sha256').update('[');
  let separator = '';
  for (const item of items) {
    hash.update(separator).update(json(item));
    separator = ',';
  }
  return hash.update(']').digest('hex');
}

export type RpcId = string | number;
export type RpcMessage =
  | { jsonrpc: '2.0'; id?: RpcId; method: string; params: Fields }
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId | null; error: { code: ErrorCode; message: string } };

export function rpcRequest(id: RpcId, method: string, params: Fields): RpcMessage {
  return { jsonrpc: '2.0', id, method, params };
}

export function parseRpc(input: unknown): RpcMessage {
  const m = object(input);
  const id = m.id;
  const validId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
  if (m.jsonrpc !== '2.0') throw new HostError('invalid_request', 'expected JSON-RPC 2.0');
  if ('method' in m && !('result' in m) && !('error' in m) && (id === undefined || validId)) {
    const method = string(m.method, 'method');
    const params = object(m.params);
    return id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  }
  if (validId && 'result' in m && !('error' in m) && !('method' in m)) {
    return { jsonrpc: '2.0', id, result: m.result };
  }
  if ((id === null || validId) && 'error' in m && !('result' in m) && !('method' in m)) {
    const error = object(m.error);
    const code = errorCodes.find(candidate => candidate === error.code);
    if (code) return { jsonrpc: '2.0', id, error: { code, message: string(error.message, 'error message') } };
  }
  throw new HostError('invalid_request', 'invalid JSON-RPC envelope');
}

export class RpcWire {
  private segments: Buffer[] = [];
  private length = 0;
  private chunk: ChunkAssembler | undefined;
  private failed = false;

  constructor(
    private readonly socket: Socket,
    onMessage: (message: RpcMessage) => void,
    onError: (error: HostError) => void,
    mayReceiveChunks: () => boolean,
  ) {
    const fail = (error: unknown) => {
      if (this.failed) return;
      this.failed = true;
      onError(error instanceof HostError ? error : new HostError('invalid_request', 'invalid frame'));
    };
    socket.on('data', (data: Buffer) => {
      if (this.failed) return;
      try {
        for (let offset = 0; offset < data.length;) {
          const newline = data.indexOf(10, offset);
          const end = newline < 0 ? data.length : newline;
          this.length += end - offset;
          if (this.length > MAX_FRAME_BYTES) throw new HostError('invalid_request', 'frame exceeds 1 MiB');
          this.segments.push(data.subarray(offset, end));
          offset = end + 1;
          if (newline < 0) break;
          const frame = Buffer.concat(this.segments, this.length);
          this.segments = [];
          this.length = 0;
          const message = parseRpc(decodeJson(frame));
          if ('method' in message && message.method === 'chunk' && message.id === undefined) {
            if (!mayReceiveChunks()) throw new HostError('unauthorized', 'chunk stream requires authentication');
            this.chunk ??= new ChunkAssembler();
            const payload = this.chunk.push(message.params);
            if (payload) {
              this.chunk = undefined;
              onMessage(parseRpc(decodeJson(payload)));
            }
          } else {
            if (this.chunk) throw new HostError('invalid_request', 'interrupted chunk stream');
            onMessage(message);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    socket.on('end', () => {
      if (this.length || this.chunk) fail(new HostError('invalid_request', 'truncated frame'));
    });
  }

  send(message: RpcMessage): void {
    if (this.socket.destroyed || this.socket.writableEnded) {
      throw new HostError('temporarily_unavailable', 'socket is closed');
    }
    const bytes = Buffer.from(json(message));
    if (this.socket.writableLength + bytes.length > 2 * MAX_PAYLOAD_BYTES) {
      throw new HostError('temporarily_unavailable', 'socket backpressure limit exceeded');
    }
    if (bytes.length <= MAX_FRAME_BYTES) {
      this.socket.write(bytes.toString('utf8') + '\n');
      return;
    }
    for (const chunk of chunkPayload(bytes)) {
      this.socket.write(json({ jsonrpc: '2.0', method: 'chunk', params: chunk }) + '\n');
    }
  }
}
