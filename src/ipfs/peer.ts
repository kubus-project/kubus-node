import type { KuboClient } from './kuboClient.js';

export async function discoverPeerId(kubo: KuboClient): Promise<string> {
  const id = await kubo.id();
  if (!id.ID) throw new Error('Kubo peer ID is missing');
  return id.ID;
}
