/**
 * How a remote WebRTC connection is carried, in operator-safe terms.
 *
 * Kept free of node-datachannel so both the decision and the redaction can be
 * tested without a native ICE stack. A selected candidate carries this
 * machine's address, port and the raw candidate line — a map of its network
 * interfaces — and none of that may leave this module: only the candidate kind
 * and its transport do.
 */

export type PeerRoute = 'relay' | 'direct' | 'unknown';

export interface CandidateKind {
  /** ICE candidate type: host, srflx, prflx or relay — or unknown. */
  type: string;
  /** udp, tcp or tls — or unknown. */
  transport: string;
}

export interface PeerRouteDiagnostics {
  route: PeerRoute;
  local: CandidateKind | null;
  remote: CandidateKind | null;
}

export interface RemoteConnectionDiagnostic extends PeerRouteDiagnostics {
  /** First eight characters of the rendezvous id: enough to correlate, not to reuse. */
  session: string;
  /** Whether the Ed25519 identity handshake completed on this channel. */
  verified: boolean;
}

const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const TRANSPORTS = new Set(['udp', 'tcp', 'tls']);

function unknown(): PeerRouteDiagnostics {
  return { route: 'unknown', local: null, remote: null };
}

/**
 * Allowlisted, never echoed: a value the ICE stack reports that is not a known
 * kind becomes `unknown` rather than reaching a page verbatim.
 */
function kindOf(candidate: unknown): CandidateKind | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const { type, transportType } = candidate as { type?: unknown; transportType?: unknown };
  if (typeof type !== 'string') return null;
  const normalizedType = type.toLowerCase() === 'relayed' ? 'relay' : type.toLowerCase();
  const normalizedTransport = typeof transportType === 'string' ? transportType.toLowerCase() : '';
  return {
    type: CANDIDATE_TYPES.has(normalizedType) ? normalizedType : 'unknown',
    transport: TRANSPORTS.has(normalizedTransport) ? normalizedTransport : 'unknown',
  };
}

/**
 * Reads node-datachannel's selected candidate pair into a verdict.
 *
 * A known relay candidate on either side is conclusive. Anything short of two
 * recognized, non-relay kinds is `unknown` rather than `direct`: "we could not
 * tell" and "no relay" are different facts, and only one of them is honest to
 * show an operator who is asking whether a relay is in the path.
 */
export function describeSelectedPair(pair: unknown): PeerRouteDiagnostics {
  if (!pair || typeof pair !== 'object') return unknown();
  const { local, remote } = pair as { local?: unknown; remote?: unknown };
  const localKind = kindOf(local);
  const remoteKind = kindOf(remote);
  if (!localKind || !remoteKind) return unknown();
  if (localKind.type === 'relay' || remoteKind.type === 'relay') {
    return { route: 'relay', local: localKind, remote: remoteKind };
  }
  if (localKind.type === 'unknown' || remoteKind.type === 'unknown') {
    return { route: 'unknown', local: localKind, remote: remoteKind };
  }
  return { route: 'direct', local: localKind, remote: remoteKind };
}

/** One row per connected peer. A peer that cannot answer is reported as unknown, not dropped. */
export function summarizeConnections(
  peers: Iterable<[string, { isVerified: boolean; routeDiagnostics(): PeerRouteDiagnostics }]>,
): RemoteConnectionDiagnostic[] {
  const summaries: RemoteConnectionDiagnostic[] = [];
  for (const [sessionId, peer] of peers) {
    let diagnostics: PeerRouteDiagnostics;
    try {
      diagnostics = peer.routeDiagnostics();
    } catch {
      diagnostics = unknown();
    }
    summaries.push({ session: sessionId.slice(0, 8), verified: peer.isVerified, ...diagnostics });
  }
  return summaries;
}
