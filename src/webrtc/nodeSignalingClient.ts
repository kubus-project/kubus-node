import crypto from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { AppConfig } from '../config/schema.js';
import type { NodeIdentity } from '../identity/nodeIdentity.js';
import type { LocalApiDeps } from '../localApi/dispatch.js';
import type { Logger } from '../logging/logger.js';
import { NodePeer, type IceServerConfig } from './nodePeer.js';

/**
 * The Node half of the short-lived signaling rendezvous.
 *
 * Signaling is deliberately allowed to fail without taking the Node down. It
 * coordinates remote WebRTC only; the local API, archive participation, and a
 * configured HTTPS ingress remain useful when the control plane is offline.
 * In contrast, every individual message is treated as hostile until its
 * session id and shape have been checked: Socket.IO tells us who delivered a
 * message, not whether it belongs to a still-live connection attempt.
 */

const NAMESPACE = '/node-signaling';
const MAX_SESSIONS = 8;
const MAX_PENDING_CANDIDATES = 64;
const MAX_ICE_SERVERS = 8;
const MAX_ICE_URLS_PER_SERVER = 4;
const MAX_ICE_URL_LENGTH = 256;

type SignalPayload = Record<string, unknown>;

interface PendingSession {
  expiresAt: number;
  candidates: Array<{ candidate: string; mid: string }>;
  peer?: NodePeer;
  timer: NodeJS.Timeout;
}

export interface NodeSignalingClientOptions {
  config: AppConfig;
  nodeId: string;
  localApi: LocalApiDeps;
  identity: NodeIdentity;
  logger: Logger;
  /** Injection point for deterministic lifecycle tests. */
  socketFactory?: (url: string, options: Record<string, unknown>) => Socket;
}

export class NodeSignalingClient {
  private readonly sessions = new Map<string, PendingSession>();
  private socket: Socket | undefined;
  private stopped = false;

  constructor(private readonly options: NodeSignalingClientOptions) {}

  start(): void {
    if (this.socket || this.stopped) return;
    const endpoint = `${this.options.config.apiBaseUrl}${NAMESPACE}`;
    const createSocket = this.options.socketFactory ?? ((url, options) => io(url, options));
    const socket = createSocket(endpoint, {
      transports: ['websocket'],
      auth: { token: this.options.config.operatorToken, nodeId: this.options.nodeId },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      timeout: 15_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      void this.announce();
    });
    socket.on('connect_error', (error: Error) => {
      // Do not include the server's text: a proxy can echo request metadata
      // (including a bearer token) in a diagnostic error.
      this.options.logger.warn({ code: error.name || 'connect_error' }, 'node signaling unavailable; remote coordination will retry');
    });
    socket.on('session:incoming', (payload: SignalPayload) => {
      void this.acceptIncoming(payload);
    });
    socket.on('signal:offer', (payload: SignalPayload) => {
      void this.acceptOffer(payload);
    });
    socket.on('signal:candidate', (payload: SignalPayload) => this.acceptCandidate(payload));
    socket.on('session:ice-restart', (payload: SignalPayload) => this.closeSession(this.sessionId(payload), 'ice_restart_requested'));
    for (const event of ['session:closed', 'session:expired', 'session:rejected'] as const) {
      socket.on(event, (payload: SignalPayload) => this.closeSession(this.sessionId(payload), event));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const socket = this.socket;
    this.socket = undefined;
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId, 'node_stopped');
    if (!socket) return;
    if (socket.connected) {
      await this.emitAck(socket, 'node:withdraw', {}).catch(() => undefined);
    }
    socket.disconnect();
  }

  private async announce(): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected || this.stopped) return;
    try {
      await this.emitAck(socket, 'node:announce', {
        protocolVersion: 1,
        fingerprint: this.options.identity.fingerprint,
        capabilities: { relay: true, directConnect: true, resumable: false },
      });
      this.options.logger.info({ nodeId: this.options.nodeId }, 'node signaling connected');
    } catch {
      // The socket's reconnect loop is the recovery mechanism. Presence being
      // absent must not make the Node's durable archive work fail.
      this.options.logger.warn({ nodeId: this.options.nodeId }, 'node signaling announce was rejected');
    }
  }

  private async acceptIncoming(payload: SignalPayload): Promise<void> {
    const sessionId = this.sessionId(payload);
    if (!sessionId || this.sessions.has(sessionId)) return;
    if (this.sessions.size >= MAX_SESSIONS) {
      await this.reject(sessionId, 'node_busy');
      return;
    }
    const expiresAt = Date.parse(typeof payload.expiresAt === 'string' ? payload.expiresAt : '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;

    const timer = setTimeout(() => this.closeSession(sessionId, 'session_expired'), Math.max(1, expiresAt - Date.now()));
    timer.unref?.();
    this.sessions.set(sessionId, { expiresAt, candidates: [], timer });
    try {
      await this.emit('session:accept', { sessionId });
    } catch {
      this.closeSession(sessionId, 'accept_failed');
    }
  }

  private async acceptOffer(payload: SignalPayload): Promise<void> {
    const sessionId = this.sessionId(payload);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    const sdp = typeof payload.sdp === 'string' ? payload.sdp : '';
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (!session || session.peer || session.expiresAt <= Date.now() || !sdp || type !== 'offer') return;

    const peer = new NodePeer({
      sessionId,
      iceServers: parseIceServers(payload.iceServers),
      deps: this.options.localApi,
      identity: this.options.identity,
      logger: this.options.logger,
      onLocalDescription: (answerSdp, answerType) => {
        void this.emit('signal:answer', { sessionId, messageId: messageId(), sdp: answerSdp, type: answerType }).catch(() => this.closeSession(sessionId, 'answer_relay_failed'));
      },
      onLocalCandidate: (candidate, mid) => {
        void this.emit('signal:candidate', { sessionId, messageId: messageId(), candidate: { candidate, sdpMid: mid } }).catch(() => this.closeSession(sessionId, 'candidate_relay_failed'));
      },
      onStateChange: (state) => {
        if (state === 'failed' || state === 'closed') this.closeSession(sessionId, `session:peer_${state}`);
      },
    });
    session.peer = peer;
    try {
      peer.setRemoteDescription(sdp, type);
      for (const candidate of session.candidates) peer.addRemoteCandidate(candidate.candidate, candidate.mid);
      session.candidates = [];
    } catch {
      this.closeSession(sessionId, 'offer_invalid');
    }
  }

  private acceptCandidate(payload: SignalPayload): void {
    const sessionId = this.sessionId(payload);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const candidateObject = isRecord(payload.candidate) ? payload.candidate : undefined;
    const candidate = typeof candidateObject?.candidate === 'string' ? candidateObject.candidate : '';
    const mid = typeof candidateObject?.sdpMid === 'string' ? candidateObject.sdpMid : '';
    if (!session || !candidate || session.expiresAt <= Date.now()) return;
    if (session.peer) {
      session.peer.addRemoteCandidate(candidate, mid);
    } else if (session.candidates.length < MAX_PENDING_CANDIDATES) {
      session.candidates.push({ candidate, mid });
    }
  }

  private async reject(sessionId: string, reason: string): Promise<void> {
    try {
      await this.emit('session:reject', { sessionId, reason });
    } catch {
      // No local state was created, so no cleanup remains.
    }
  }

  private closeSession(sessionId: string | undefined, reason: string): void {
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    session.peer?.close();
    // Closing a session is best-effort; it is short-lived at the control plane
    // even when this socket is already gone.
    if (this.socket?.connected && !reason.startsWith('session:')) {
      void this.emit('session:close', { sessionId, reason }).catch(() => undefined);
    }
  }

  private sessionId(payload: SignalPayload): string | undefined {
    const value = payload.sessionId;
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;
  }

  private emit(event: string, payload: SignalPayload): Promise<SignalPayload> {
    const socket = this.socket;
    if (!socket?.connected) return Promise.reject(new Error('signaling_disconnected'));
    return this.emitAck(socket, event, payload);
  }

  private emitAck(socket: Socket, event: string, payload: SignalPayload): Promise<SignalPayload> {
    return new Promise<SignalPayload>((resolve, reject) => {
      socket.timeout(15_000).emit(event, payload, (error: Error | null, response?: SignalPayload) => {
        if (error || !response || response.ok === false) reject(error ?? new Error('signaling_rejected'));
        else resolve(response);
      });
    });
  }
}

function parseIceServers(value: unknown): IceServerConfig[] {
  if (!Array.isArray(value)) return [];
  const servers: IceServerConfig[] = [];
  for (const raw of value.slice(0, MAX_ICE_SERVERS)) {
    if (!isRecord(raw)) continue;
    const urls = Array.isArray(raw.urls) ? raw.urls : [raw.urls];
    const username = typeof raw.username === 'string' ? raw.username : undefined;
    const credential = typeof raw.credential === 'string' ? raw.credential : undefined;
    for (const url of urls.slice(0, MAX_ICE_URLS_PER_SERVER)) {
      if (typeof url !== 'string' || url.length > MAX_ICE_URL_LENGTH || !/^(stun|stuns|turn|turns):/i.test(url)) continue;
      servers.push({ urls: url, ...(username ? { username } : {}), ...(credential ? { credential } : {}) });
    }
  }
  return servers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageId(): string {
  return crypto.randomBytes(16).toString('hex');
}
