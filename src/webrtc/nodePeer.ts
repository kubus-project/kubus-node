import { Buffer } from 'node:buffer';
import { DataChannel, PeerConnection, type DescriptionType } from 'node-datachannel';
import type { NodeIdentity } from '../identity/nodeIdentity.js';
import type { LocalApiDeps } from '../localApi/dispatch.js';
import type { Logger } from '../logging/logger.js';
import { ChannelServer, type ChannelTransport } from './channelServer.js';

/**
 * One WebRTC peer connection with a paired device.
 *
 * The node is always the answerer: a device asks the control plane to reach
 * its Node, never the other way round, so the node never needs to know where a
 * phone is — only how to answer when one turns up. That asymmetry is what
 * keeps the node from having to be addressable at all.
 *
 * The connection carries exactly one reliable, ordered data channel, and that
 * channel carries the same `/local/v1/...` operations HTTP carries. There is
 * no second API here.
 */

export interface NodePeerOptions {
  /** The signaling session this connection belongs to. Binds the identity proof. */
  sessionId: string;
  iceServers: IceServerConfig[];
  deps: LocalApiDeps;
  identity: NodeIdentity;
  logger?: Logger;
  /** Emitted for the control plane to relay. Never logged. */
  onLocalDescription: (sdp: string, type: string) => void;
  onLocalCandidate: (candidate: string, mid: string) => void;
  onStateChange?: (state: NodePeerState) => void;
  /** Overall deadline for reaching a connected state before the attempt is abandoned. */
  connectTimeoutMs?: number;
}

export interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

export type NodePeerState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * The sub-protocol label a kubus client opens its channel with.
 *
 * Ordering and reliability are not negotiable for this protocol: the framing
 * layer reassembles a body by arrival order and verifies it with a CRC, so an
 * unordered or lossy channel would surface as a corrupted capture rather than
 * as a connection error. libdatachannel's default is ordered and fully
 * reliable (`unordered` absent, no `maxRetransmits`/`maxPacketLifeTime`), which
 * is what the client must use.
 */
export const CHANNEL_PROTOCOL = 'kubus/1';

/** Bounds how many candidates a peer may push at us before we stop listening. */
const MAX_REMOTE_CANDIDATES = 64;

/** A candidate line longer than this is malformed or hostile; neither deserves parsing. */
const MAX_CANDIDATE_LENGTH = 512;

export class NodePeer {
  private readonly connection: PeerConnection;
  private readonly options: NodePeerOptions;
  private channelServer: ChannelServer | undefined;
  private dataChannel: DataChannel | undefined;
  private remoteCandidateCount = 0;
  private connectTimer: NodeJS.Timeout | undefined;
  private state: NodePeerState = 'new';
  private closed = false;

  constructor(options: NodePeerOptions) {
    this.options = options;
    this.connection = new PeerConnection(`kubus-node-${options.sessionId.slice(0, 8)}`, {
      iceServers: options.iceServers.map((server) =>
        server.username !== undefined && server.credential !== undefined
          ? {
              hostname: hostnameOf(server.urls),
              port: portOf(server.urls),
              username: server.username,
              password: server.credential,
              relayType: relayTypeOf(server.urls),
            }
          : server.urls,
      ) as never,
    });

    this.connection.onLocalDescription((sdp, type) => {
      // Never logged: an SDP carries host addresses and the DTLS fingerprint.
      this.options.onLocalDescription(sdp, type);
    });

    this.connection.onLocalCandidate((candidate, mid) => {
      // Also never logged — a candidate line is a map of this machine's
      // network interfaces.
      this.options.onLocalCandidate(candidate, mid);
    });

    this.connection.onStateChange((state) => this.onConnectionState(state));

    this.connection.onDataChannel((channel) => this.adoptChannel(channel));

    this.connectTimer = setTimeout(() => {
      if (this.state !== 'connected') {
        this.options.logger?.info(
          { sessionId: this.options.sessionId },
          'webrtc connection attempt timed out',
        );
        this.close();
      }
    }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();
  }

  /** Applies the caller's offer. The answer arrives via `onLocalDescription`. */
  setRemoteDescription(sdp: string, type: string): void {
    if (this.closed) return;
    this.connection.setRemoteDescription(sdp, type as DescriptionType);
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    if (this.closed) return;
    if (this.remoteCandidateCount >= MAX_REMOTE_CANDIDATES) return;
    if (typeof candidate !== 'string' || candidate.length === 0) return;
    if (candidate.length > MAX_CANDIDATE_LENGTH) return;
    // A candidate must look like one. This is not a full grammar check — the
    // ICE stack does that — but it stops obviously malformed input from
    // reaching it at all.
    if (!/^(a=)?candidate:/i.test(candidate.trim())) return;
    this.remoteCandidateCount += 1;
    try {
      this.connection.addRemoteCandidate(candidate, mid);
    } catch {
      // A rejected candidate is one fewer path, never a fatal condition.
    }
  }

  /**
   * Whether this connection is relayed.
   *
   * Reported to the operator as diagnostics, and used to explain to a user why
   * a transfer is slower than usual. It is not a trust statement: relayed
   * traffic is still DTLS-encrypted end to end and the relay never holds a key.
   */
  isRelayed(): boolean {
    try {
      const pair = this.connection.getSelectedCandidatePair();
      return pair?.local?.type === 'relay' || pair?.remote?.type === 'relay';
    } catch {
      return false;
    }
  }

  get currentState(): NodePeerState {
    return this.state;
  }

  get isVerified(): boolean {
    return this.channelServer?.isIdentityVerified ?? false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.channelServer?.close();
    this.channelServer = undefined;
    try {
      this.dataChannel?.close();
    } catch {
      // Already gone.
    }
    this.dataChannel = undefined;
    try {
      this.connection.close();
    } catch {
      // Already gone.
    }
    this.setState('closed');
  }

  private adoptChannel(channel: DataChannel): void {
    if (this.closed) {
      try {
        channel.close();
      } catch {
        // Nothing to do.
      }
      return;
    }
    // Exactly one channel per connection. A peer offering a second is either
    // confused or probing; neither gets a second dispatcher.
    if (this.dataChannel) {
      try {
        channel.close();
      } catch {
        // Nothing to do.
      }
      return;
    }

    // Require the label a kubus client announces. It costs nothing, and it
    // means a peer speaking some other protocol is turned away before its
    // bytes ever reach the frame decoder.
    const protocol = safeProtocol(channel);
    if (protocol && protocol !== CHANNEL_PROTOCOL) {
      this.options.logger?.warn(
        { sessionId: this.options.sessionId },
        'data channel refused: unexpected protocol label',
      );
      try {
        channel.close();
      } catch {
        // Nothing to do.
      }
      return;
    }

    this.dataChannel = channel;
    const transport: ChannelTransport = {
      send: (data: Buffer) => {
        channel.sendMessageBinary(data);
      },
      close: () => {
        try {
          channel.close();
        } catch {
          // Already gone.
        }
      },
      get isOpen() {
        try {
          return channel.isOpen();
        } catch {
          return false;
        }
      },
    };

    this.channelServer = new ChannelServer(transport, {
      deps: this.options.deps,
      identity: this.options.identity,
      sessionId: this.options.sessionId,
      logger: this.options.logger,
    });

    channel.onMessage((message) => {
      // Text frames are not part of this protocol. A peer sending one is
      // speaking something else, and guessing at it would be the start of a
      // parser bug.
      if (typeof message === 'string') return;
      // Binary arrives as an ArrayBuffer or a Buffer depending on the build;
      // normalise once here so the codec only ever sees a Buffer.
      this.channelServer?.handleMessage(
        Buffer.isBuffer(message) ? message : Buffer.from(new Uint8Array(message)),
      );
    });

    channel.onClosed(() => {
      this.channelServer?.close();
      this.channelServer = undefined;
    });

    channel.onError(() => {
      this.channelServer?.close();
      this.channelServer = undefined;
    });
  }

  private onConnectionState(state: string): void {
    switch (state) {
      case 'connecting':
        this.setState('connecting');
        return;
      case 'connected':
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
        this.setState('connected');
        return;
      case 'disconnected':
        this.setState('disconnected');
        return;
      case 'failed':
        this.setState('failed');
        this.close();
        return;
      case 'closed':
        this.setState('closed');
        return;
      default:
        return;
    }
  }

  private setState(state: NodePeerState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}

/**
 * node-datachannel takes TURN servers as structured fields rather than a URL,
 * so a `turn:` / `turns:` URL has to be taken apart. Kept small and total:
 * anything unparseable falls back to a plain STUN-style string, which the
 * library also accepts.
 */
function hostnameOf(url: string): string {
  const withoutScheme = url.replace(/^(stun|stuns|turn|turns):/i, '');
  const withoutQuery = withoutScheme.split('?')[0] ?? withoutScheme;
  const lastColon = withoutQuery.lastIndexOf(':');
  return lastColon > 0 ? withoutQuery.slice(0, lastColon) : withoutQuery;
}

function portOf(url: string): number {
  const withoutScheme = url.replace(/^(stun|stuns|turn|turns):/i, '');
  const withoutQuery = withoutScheme.split('?')[0] ?? withoutScheme;
  const lastColon = withoutQuery.lastIndexOf(':');
  if (lastColon <= 0) return /^turns:/i.test(url) ? 5349 : 3478;
  const parsed = Number.parseInt(withoutQuery.slice(lastColon + 1), 10);
  return Number.isFinite(parsed) ? parsed : 3478;
}

function relayTypeOf(url: string): 'TurnUdp' | 'TurnTcp' | 'TurnTls' {
  if (/^turns:/i.test(url)) return 'TurnTls';
  if (/transport=tcp/i.test(url)) return 'TurnTcp';
  return 'TurnUdp';
}

/** libdatachannel throws rather than returning null when a channel is already gone. */
function safeProtocol(channel: DataChannel): string {
  try {
    return channel.getProtocol();
  } catch {
    return '';
  }
}

export { hostnameOf as parseIceHostname, portOf as parseIcePort, relayTypeOf as parseIceRelayType };
