import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

interface Owner { version: 1; pid: number; host: string; namespace: string; boot?: string; processStart?: string; nonce: string; }
const processStart = String(Math.round(Date.now() - process.uptime() * 1000));
async function identity(pid = process.pid): Promise<Omit<Owner, 'version' | 'nonce'>> {
  const host = os.hostname();
  if (process.platform !== 'linux') return { pid, host, namespace: process.platform, processStart: pid === process.pid ? processStart : undefined };
  const namespace = await fs.readlink('/proc/self/ns/pid');
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  return { pid, host, namespace, boot, processStart: start };
}
function valid(value: Owner): boolean {
  return value?.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === 'string' &&
    typeof value.namespace === 'string' && typeof value.nonce === 'string' && value.nonce.length > 10;
}
async function readOwner(file: string): Promise<Owner> {
  const owner = JSON.parse(await fs.readFile(file, 'utf8')) as Owner;
  if (!valid(owner)) throw new Error('runtime_lease_owner_unverified'); return owner;
}
async function provenStopped(owner: Owner, current: Omit<Owner, 'version' | 'nonce'>): Promise<boolean> {
  // Another host/PID namespace is not observable from this process. Retain the
  // lease for explicit operator recovery rather than guessing it is dead.
  if (owner.host !== current.host) return false;
  // A different kernel boot id on the same host proves the recorded process died
  // with the previous boot. This must precede the namespace comparison: after a
  // host crash a restarted container always has a new PID namespace, which would
  // otherwise keep the stale lease and fail every start until manual cleanup.
  if (owner.boot && current.boot && owner.boot !== current.boot) return true;
  // Same boot, different PID namespace: the owner is not observable from here.
  if (owner.namespace !== current.namespace) return false;
  try { process.kill(owner.pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const live = owner.pid === process.pid ? current : await identity(owner.pid);
  return Boolean(owner.processStart && live.processStart && owner.processStart !== live.processStart);
}

/** Exclusive official runtime/maintenance writer. Diagnostic commands do not claim it. */
export async function acquireRuntimeLease(stateFile: string): Promise<{ release(): Promise<void> }> {
  const file = `${path.resolve(stateFile)}.runtime-lease`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const current = await identity(); const owner: Owner = { version: 1, ...current, nonce: crypto.randomUUID() };
  const temporary = `${file}.${owner.nonce}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await fs.link(temporary, file); return { release: async () => {
        const actual = await readOwner(file).catch(() => null);
        if (actual?.nonce === owner.nonce) await fs.unlink(file);
      } }; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const existing = await readOwner(file);
      if (!await provenStopped(existing, current)) throw new Error('runtime_writer_already_active_or_unverified');
      // Serialize stale-owner reclamation. Every reaper reads the owner again
      // after claiming this guard, so it cannot delete a replacement live lease.
      const reaper = `${file}.reclaim`;
      try { await fs.mkdir(reaper); } catch { throw new Error('runtime_lease_recovery_requires_review'); }
      try {
        const actual = await readOwner(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (actual && await provenStopped(actual, current)) await fs.unlink(file);
      } finally { await fs.rmdir(reaper); }
    }
    throw new Error('runtime_lease_acquisition_contended');
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
