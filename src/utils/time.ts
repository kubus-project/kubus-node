export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isoNow(): string {
  return new Date().toISOString();
}

export function addHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function jitterMs(intervalMs: number, ratio = 0.15): number {
  const spread = Math.max(0, intervalMs * ratio);
  return Math.max(1000, Math.round(intervalMs + (Math.random() * spread * 2 - spread)));
}
