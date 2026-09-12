import { describe, expect, it } from 'vitest';
import { describeSelectedPair, summarizeConnections, type PeerRouteDiagnostics } from '../src/webrtc/peerRoute.js';

/**
 * Route diagnostics exist so an operator can see whether a remote connection
 * is carried by a TURN relay. They must say that — and nothing that maps this
 * machine's network: a selected candidate carries the host address, port and
 * the raw candidate line, and none of those may leave this module.
 */

const ADDRESS = '203.0.113.7';
const PORT = 54321;

function candidate(type: string, transportType = 'UDP') {
  return {
    address: ADDRESS,
    port: PORT,
    type,
    transportType,
    candidate: `candidate:1 1 ${transportType} 2122260223 ${ADDRESS} ${PORT} typ ${type}`,
    mid: '0',
    priority: 2122260223,
  };
}

describe('describeSelectedPair', () => {
  it('reports unknown rather than guessing when no pair has been selected', () => {
    for (const pair of [null, undefined, {}, { local: candidate('host') }]) {
      expect(describeSelectedPair(pair)).toEqual({ route: 'unknown', local: null, remote: null });
    }
  });

  it('calls a pair relayed when the local side is a relay candidate', () => {
    expect(describeSelectedPair({ local: candidate('relay'), remote: candidate('srflx') })).toEqual({
      route: 'relay',
      local: { type: 'relay', transport: 'udp' },
      remote: { type: 'srflx', transport: 'udp' },
    });
  });

  it('calls a pair relayed when only the remote side is a relay candidate', () => {
    expect(describeSelectedPair({ local: candidate('host'), remote: candidate('relay', 'TCP') }).route).toBe('relay');
  });

  it('calls a pair direct when neither side is relayed', () => {
    for (const [local, remote] of [['host', 'host'], ['srflx', 'prflx'], ['prflx', 'srflx']] as const) {
      expect(describeSelectedPair({ local: candidate(local), remote: candidate(remote) }).route).toBe('direct');
    }
  });

  it('never carries an address, a port or a raw candidate line', () => {
    const serialized = JSON.stringify(describeSelectedPair({ local: candidate('relay'), remote: candidate('host') }));
    expect(serialized).not.toContain(ADDRESS);
    expect(serialized).not.toContain(String(PORT));
    expect(serialized).not.toContain('candidate:');
    // Match keys, not substrings: "transport" legitimately contains "port".
    expect(serialized).not.toMatch(/"(address|port|priority|mid|candidate)"/);
  });

  it('does not pass arbitrary strings from the ICE stack through to the page', () => {
    const described = describeSelectedPair({
      local: { ...candidate('host'), type: '<img src=x onerror=alert(1)>', transportType: 'udp;drop' },
      remote: candidate('host'),
    });
    expect(described.local).toEqual({ type: 'unknown', transport: 'unknown' });
    // An unrecognized kind is not evidence of a direct path.
    expect(described.route).toBe('unknown');
  });

  it('still calls a relay a relay when the other side is unrecognized', () => {
    const described = describeSelectedPair({ local: { ...candidate('host'), type: 'mystery' }, remote: candidate('relay') });
    expect(described.route).toBe('relay');
  });
});

describe('summarizeConnections', () => {
  const route = (diagnostics: PeerRouteDiagnostics) => ({ routeDiagnostics: () => diagnostics });

  it('identifies a session only by a short prefix, never the full rendezvous id', () => {
    const fullSessionId = 'AbCdEfGh1234567890abcdefghijklmnopqrstuvwx';
    const [summary] = summarizeConnections([
      [fullSessionId, { isVerified: true, ...route({ route: 'relay', local: { type: 'relay', transport: 'udp' }, remote: { type: 'srflx', transport: 'udp' } }) }],
    ]);
    expect(summary).toEqual({
      session: 'AbCdEfGh',
      verified: true,
      route: 'relay',
      local: { type: 'relay', transport: 'udp' },
      remote: { type: 'srflx', transport: 'udp' },
    });
    expect(JSON.stringify(summary)).not.toContain(fullSessionId);
  });

  it('keeps unverified and unreported connections visible as such', () => {
    const summaries = summarizeConnections([
      ['session-one-xyz', { isVerified: false, ...route({ route: 'unknown', local: null, remote: null }) }],
      ['session-two-xyz', { isVerified: true, ...route({ route: 'direct', local: { type: 'host', transport: 'udp' }, remote: { type: 'host', transport: 'udp' } }) }],
    ]);
    expect(summaries.map((s) => [s.session, s.verified, s.route])).toEqual([
      ['session-', false, 'unknown'],
      ['session-', true, 'direct'],
    ]);
  });

  it('survives a peer whose diagnostics call throws', () => {
    const [summary] = summarizeConnections([
      ['session-bad-xyz', { isVerified: true, routeDiagnostics: () => { throw new Error('closed'); } }],
    ]);
    expect(summary).toMatchObject({ route: 'unknown', local: null, remote: null });
  });
});
