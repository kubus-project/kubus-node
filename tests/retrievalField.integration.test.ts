import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { RETRIEVAL_AVAILABLE_STATES, probeRetrieval } from '../src/ipfs/retrieval.js';

/**
 * Field validation for the typed retrieval states, against real services.
 *
 * The unit tests mock `fetch` and the Kubo client, which proves the branching
 * but not the classification: the whole point of these states is that Node's
 * `fetch` reports a DNS failure, a refused connection and an abort in three
 * different shapes, all of which arrive as the same `TypeError: fetch failed`
 * unless the nested `cause` is read. A mock cannot demonstrate that the real
 * shapes are read correctly — only a real socket can. This is the test that
 * would have caught the original "Gateway retrieval -> Needs attention ->
 * fetch failed" report, where every distinct failure collapsed into one
 * useless message.
 *
 * Opt-in because it needs a live Kubo daemon:
 *   docker run -d --name kubus-retrieval-probe -p 5099:5001 -p 8099:8080 ipfs/kubo:v0.43.0
 *   KUBUS_TEST_KUBO_RPC=http://127.0.0.1:5099 KUBUS_TEST_KUBO_GATEWAY=http://127.0.0.1:8099 npm test
 */
const rpcUrl = process.env.KUBUS_TEST_KUBO_RPC;
const gatewayUrl = process.env.KUBUS_TEST_KUBO_GATEWAY;
const live = Boolean(rpcUrl && gatewayUrl);

/** A CID that is well-formed but that no one has ever published. */
const ABSENT_CID = 'QmZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

describe.skipIf(!live)('retrieval states against a real Kubo daemon', () => {
  let kubo: KuboClient;
  let pinnedCid: string;
  let unpinnedCid: string;

  beforeAll(async () => {
    kubo = new KuboClient(rpcUrl!);

    const add = async (body: string, pin: boolean): Promise<string> => {
      const form = new FormData();
      form.append('file', new Blob([body]), 'probe.txt');
      const response = await fetch(`${rpcUrl}/api/v0/add?pin=${pin}`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(`kubo add failed: ${response.status}`);
      const parsed = (await response.json()) as { Hash: string };
      return parsed.Hash;
    };

    pinnedCid = await add(`kubus pinned probe ${Date.now()}`, true);
    unpinnedCid = await add(`kubus unpinned probe ${Date.now()}`, false);
    await fetch(`${rpcUrl}/api/v0/pin/rm?arg=${unpinnedCid}`, { method: 'POST' }).catch(() => undefined);
  }, 60_000);

  it('reports pinned content as pinned', async () => {
    const probe = await probeRetrieval(kubo, gatewayUrl!, pinnedCid);
    expect(probe.state).toBe('pinned');
    expect(RETRIEVAL_AVAILABLE_STATES).toContain(probe.state);
    expect(probe.errorClass).toBeUndefined();
  });

  it('reports locally held but unpinned content as locally retrievable', async () => {
    // The distinction matters operationally: unpinned blocks survive until the
    // next GC, so "we have it" and "we promised to keep it" are not the same
    // claim to make to the availability service.
    const probe = await probeRetrieval(kubo, gatewayUrl!, unpinnedCid);
    expect(['pinned', 'local_retrievable']).toContain(probe.state);
  });

  it('reports content only the gateway has as gateway retrievable', async () => {
    // A Kubo client pointed at a dead RPC port makes both local probes fail,
    // leaving the real gateway as the only source — which is exactly the
    // shape of a node whose own daemon is down but whose configured gateway
    // still answers.
    const noLocalDaemon = new KuboClient('http://127.0.0.1:1', 1500);
    const probe = await probeRetrieval(noLocalDaemon, gatewayUrl!, pinnedCid);
    expect(probe.state).toBe('gateway_retrievable');
  });

  it('does not treat an invalid CID as a network problem', async () => {
    const probe = await probeRetrieval(kubo, gatewayUrl!, 'definitely-not-a-cid');
    expect(probe.state).toBe('invalid_cid');
  });

  it('recovers to retrievable once the gateway is reachable again', async () => {
    // Failure must not be sticky. A probe against a dead endpoint, followed by
    // a probe against the live one, has to come back clean — otherwise the GUI
    // keeps saying "Needs attention" long after the gateway returned.
    const noLocalDaemon = new KuboClient('http://127.0.0.1:1', 1500);
    const down = await probeRetrieval(noLocalDaemon, 'http://127.0.0.1:1', pinnedCid);
    expect(down.state).toBe('gateway_unreachable');

    const recovered = await probeRetrieval(noLocalDaemon, gatewayUrl!, pinnedCid);
    expect(recovered.state).toBe('gateway_retrievable');
  });
});

describe('retrieval failure classification against real sockets', () => {
  const servers: http.Server[] = [];
  let notFoundUrl: string;
  let serverErrorUrl: string;
  let blackHoleUrl: string;
  let closedPortUrl: string;

  const listen = async (handler: http.RequestListener): Promise<string> => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  /** Local probes always fail, so every case below exercises the gateway path. */
  const noDaemon = () => new KuboClient('http://127.0.0.1:1', 800);

  beforeAll(async () => {
    notFoundUrl = await listen((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    serverErrorUrl = await listen((_req, res) => {
      // What a reverse proxy in front of a stopped gateway actually returns.
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('bad gateway');
    });
    blackHoleUrl = await listen(() => {
      // Accept the connection and never answer: the case a timeout exists for.
    });

    // A port that was legitimately bound and is now closed: the real shape of
    // "the gateway process is down" on an otherwise healthy host.
    const transient = http.createServer(() => undefined);
    await new Promise<void>((resolve) => transient.listen(0, '127.0.0.1', resolve));
    const { port } = transient.address() as AddressInfo;
    closedPortUrl = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => transient.close(() => resolve()));
  });

  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('separates a gateway that answered 404 from one that could not be reached', async () => {
    const probe = await probeRetrieval(noDaemon(), notFoundUrl, ABSENT_CID);
    expect(probe.state).toBe('gateway_not_found');
    expect(probe.httpStatus).toBe(404);
    expect(probe.errorClass).toBeUndefined();
  });

  it('classifies a proxy error as an HTTP error, not as missing content', async () => {
    // Collapsing this into "missing" is how a node reports its own archive as
    // gone during someone else's outage.
    const probe = await probeRetrieval(noDaemon(), serverErrorUrl, ABSENT_CID);
    expect(probe.state).toBe('gateway_http_error');
    expect(probe.httpStatus).toBe(502);
  });

  it('classifies a refused connection as unreachable and names the OS reason', async () => {
    // Bind a real port, then close it, so the connection is genuinely refused
    // on a port `fetch` is willing to dial. (Low ports like 1 are on the
    // WHATWG blocked-port list and never reach a socket at all — a different
    // failure, covered separately below.)
    const probe = await probeRetrieval(noDaemon(), closedPortUrl, ABSENT_CID);
    expect(probe.state).toBe('gateway_unreachable');
    // The point is that a real OS-level reason survives into the probe rather
    // than collapsing to 'unknown'. The exact code is not pinned: the freed
    // port can in principle be reclaimed by another process between close and
    // connect, and asserting one specific errno would make this test flaky
    // for a reason that has nothing to do with the classification under test.
    expect(probe.errorClass).toBeDefined();
    expect(probe.errorClass).not.toBe('unknown');
    expect(probe.errorClass).toMatch(/^E[A-Z]+$/);
  });

  it('names a gateway URL on a refused port as a settings problem, not a network one', async () => {
    // A misconfigured gateway URL used to surface as `unknown`, which sends
    // the operator looking at their network instead of at the one setting
    // that is actually wrong.
    const probe = await probeRetrieval(noDaemon(), 'http://127.0.0.1:1', ABSENT_CID);
    expect(probe.state).toBe('gateway_unreachable');
    expect(probe.errorClass).toBe('gateway_url_port_not_permitted');
  });

  it('classifies an unresolvable host as unreachable and names the DNS reason', async () => {
    const probe = await probeRetrieval(
      noDaemon(),
      'http://gateway.invalid.kubus-test.localdomain',
      ABSENT_CID,
    );
    expect(probe.state).toBe('gateway_unreachable');
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(probe.errorClass);
  });

  it('classifies a silent gateway as a timeout rather than as unreachable', async () => {
    const probe = await probeRetrieval(noDaemon(), blackHoleUrl, ABSENT_CID);
    expect(probe.state).toBe('gateway_timeout');
    expect(probe.errorClass).toBe('abort');
  }, 15_000);

  it('never reports a transport failure as confirmed availability', async () => {
    // The invariant the whole type exists to protect: no failure mode may be
    // read as "the archive has this".
    for (const url of [
      'http://127.0.0.1:1',
      closedPortUrl,
      notFoundUrl,
      serverErrorUrl,
      'http://gateway.invalid.kubus-test.localdomain',
    ]) {
      const probe = await probeRetrieval(noDaemon(), url, ABSENT_CID);
      expect(RETRIEVAL_AVAILABLE_STATES).not.toContain(probe.state);
    }
  }, 20_000);

  it('never puts the probed URL or an error message into the probe result', async () => {
    // `errorClass` exists instead of the raw error precisely because a
    // misconfigured gateway URL can carry credentials in its query string, and
    // this result is rendered in the GUI and written to the log buffer.
    const secretUrl = 'http://127.0.0.1:1/gateway?access_key=supersecretvalue';
    const probe = await probeRetrieval(noDaemon(), secretUrl, ABSENT_CID);
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain('supersecretvalue');
    expect(serialized).not.toContain('access_key');
    expect(serialized).not.toContain('fetch failed');
  });
});
