import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import { contractError } from './errors.js';

type Wire = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;
export type SocketFactory = (endpoint: string) => Socket;
interface ProxyWebSocket {
  on(event:'open' | 'error' | 'close', listener:() => void): this;
  on(event:'message', listener:(data:Buffer,binary:boolean) => void): this;
  send(data:string): void;
  terminate(): void;
}
type ProxyWebSocketConstructor = new (url:string, options:{createConnection:() => Duplex; maxPayload:number; perMessageDeflate:boolean}) => ProxyWebSocket;
class ProxySocket extends EventTarget {
  readyState = 0;
  private child = spawn('codex', ['app-server', 'proxy'], {stdio:['pipe','pipe','ignore']});
  private socket: ProxyWebSocket;
  constructor() { super();
    // The proxy is a raw stream, including the HTTP upgrade and WebSocket frames.
    // ws is pinned in package-lock; the child streams form one duplex socket.
    const WebSocketClient = createRequire(import.meta.url)('ws') as ProxyWebSocketConstructor;
    const stream = Duplex.from({readable:this.child.stdout,writable:this.child.stdin});
    this.socket = new WebSocketClient('ws://localhost/', {createConnection:() => stream, maxPayload:16*1024*1024, perMessageDeflate:false});
    this.socket.on('open', () => { this.readyState=1; this.dispatchEvent(new Event('open')); });
    this.socket.on('message', (data:Buffer, binary:boolean) => { if (binary) { this.close(); return; } this.dispatchEvent(new MessageEvent('message',{data:data.toString('utf8')})); });
    this.socket.on('error', () => { this.dispatchEvent(new Event('error')); });
    this.socket.on('close', () => this.closed());
    this.child.on('error', () => { this.dispatchEvent(new Event('error')); this.closed(); });
    this.child.on('close', () => this.closed());
    this.child.stdin.on('error', () => { this.dispatchEvent(new Event('error')); this.closed(); });
  }
  private closed() { if(this.readyState===3)return; this.readyState=3; this.child.kill(); this.dispatchEvent(new Event('close')); }
  send(raw:string) { if(this.readyState!==1)throw Error('proxy closed'); this.socket.send(raw); }
  close() { if(this.readyState===3)return; this.socket.terminate(); this.child.kill(); this.closed(); }
}
/** Connection-scoped JSON-RPC transport. Never starts or owns an app-server. */
export class CodexTransport {
  private socket: Socket | undefined;
  private serial = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  generation = 0;
  lastError: string | null = null;
  updatedAt = new Date().toISOString();
  health() { return { component: 'codex-transport', status: this.connected ? (this.lastError ? 'degraded' as const : 'healthy' as const) : 'unreachable' as const, reason: this.connected ? this.lastError : (this.lastError ?? 'not connected'), backlog: this.pending.size, lastDeliveryAt: null, updatedAt: this.updatedAt }; }
  private fault(reason:string) { this.lastError = reason; this.updatedAt = new Date().toISOString(); }
  get connected(): boolean { return this.socket?.readyState === 1; }
  onMessage: (message: Wire, generation: number) => void = () => {};
  onDisconnect: (generation: number) => void = () => {};
  constructor(readonly endpoint: string, private readonly factory: SocketFactory = url => url === 'codex-proxy://default' ? new ProxySocket() as unknown as Socket : new WebSocket(url), private readonly timeoutMs = 15000) {
    const url = new URL(endpoint);
    if (!(endpoint === 'codex-proxy://default' || ['ws:', 'wss:'].includes(url.protocol)) || url.username || url.password) throw contractError('invalid_request', 'invalid WebSocket endpoint');
  }
  seedGeneration(minimum:number): void { if (!Number.isSafeInteger(minimum) || minimum < 0 || this.pending.size) throw contractError('busy','cannot seed active transport'); if (this.generation <= minimum) this.generation = minimum + (this.connected ? 1 : 0); }
  async connect(): Promise<void> {
    if (this.socket) throw contractError('busy', 'connection already active');
    const socket = this.factory(this.endpoint); this.socket = socket; const generation = ++this.generation;
    socket.addEventListener('message', (event: Event) => {
      if (this.socket !== socket) return;
      let message: Wire; try { message = JSON.parse(String((event as MessageEvent).data)) as Wire; } catch { this.fault('invalid app-server message'); return; }
      if (typeof message.id === 'number' && !message.method && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(entry.timer);
        if ('error' in message) { this.fault('app-server rejected request'); entry.reject(contractError('temporarily_unavailable', 'app-server rejected request')); } else { this.lastError = null; this.updatedAt = new Date().toISOString(); entry.resolve(message.result); }
      } else this.onMessage(message, this.generation);
    });
    socket.addEventListener('close', () => this.closed(socket, this.generation));
    socket.addEventListener('error', () => { if (this.socket === socket) this.fault('transport error'); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(contractError('temporarily_unavailable', 'connection timed out')), this.timeoutMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(contractError('temporarily_unavailable', 'connection failed')); }, { once: true });
      });
      await this.request('initialize', { clientInfo: { name: 'unified-codex-adapter', version: '1' } });
      this.notify('initialized', {}); this.lastError = null; this.updatedAt = new Date().toISOString();
    } catch (e) { this.closed(socket, this.generation); socket.close(); throw e; }
  }
  private closed(socket: Socket, generation: number): void {
    if (this.socket !== socket) return;
    this.socket = undefined; this.fault('connection closed');
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(contractError('outcome_unknown', 'connection lost after request was sent')); }
    this.pending.clear(); this.onDisconnect(generation);
  }
  close(): void { const s = this.socket; if (s) { this.closed(s, this.generation); s.close(); } }
  request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(contractError('temporarily_unavailable', 'not connected'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.fault('response timed out'); reject(contractError('outcome_unknown', 'response timed out')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); this.fault('send failed'); reject(contractError('outcome_unknown', 'send failed')); }
    });
  }
  notify(method: string, params: unknown): void { this.send({ method, params }); }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  private send(message: Wire): void {
    if (!this.socket || this.socket.readyState !== 1) throw contractError('temporarily_unavailable', 'not connected');
    try { this.socket.send(JSON.stringify(message)); } catch { this.fault('send failed'); throw contractError('outcome_unknown', 'send failed'); }
  }
}
