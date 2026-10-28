/** Synthetic failure after the direct RPC server completed its response. */
export function completedKuboError(message: string): Error & { kuboResponseComplete: true } {
  return Object.assign(new Error(message), { kuboResponseComplete: true as const });
}
