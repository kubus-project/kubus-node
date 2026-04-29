import os from 'node:os';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboHealth } from '../ipfs/health.js';
import type { LocalStore } from '../state/localStore.js';
import { resolveNodeKey } from '../config/env.js';

export const AGENT_VERSION = 'kubus-node/0.1.0';

export async function registerNode(api: KubusApiClient, store: LocalStore, config: AppConfig, peerId: string, kuboHealth: KuboHealth) {
  const nodeKey = await resolveNodeKey(config, store);
  const node = await api.registerNode({
    nodeKey,
    endpointUrl: config.nodeEndpointUrl,
    label: config.nodeLabel,
    status: 'registered',
    metadata: {
      agentVersion: AGENT_VERSION,
      peerId,
      platform: `${os.platform()}-${os.arch()}`,
      kuboVersion: kuboHealth.version,
      capabilities: ['kubo-rpc', 'pinning', 'gateway-retrieval', 'availability-v1'],
      verifierEndpointUrl: config.verifierEndpointUrl || null,
    },
  });
  await store.update((state) => {
    state.nodeKey = nodeKey;
    state.nodeId = node.id;
    state.registeredAt = node.registeredAt || new Date().toISOString();
    state.peerId = peerId;
    state.node = node;
  });
  return node;
}

export async function ensureRegistered(api: KubusApiClient, store: LocalStore, config: AppConfig, peerId: string, kuboHealth: KuboHealth) {
  const current = await api.getCurrentNode().catch(() => null);
  if (current?.node) {
    await store.update((state) => {
      state.nodeId = current.node?.id;
      state.node = current.node;
      state.latestStatus = current;
      state.peerId = peerId;
    });
    return current.node;
  }
  return registerNode(api, store, config, peerId, kuboHealth);
}
