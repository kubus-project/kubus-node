import { canonicalPinCid } from '../utils/cid.js';
export { canonicalPinCid } from '../utils/cid.js';
import type { KuboClient } from './kuboClient.js';
import type { LocalState, LocalStore } from '../state/localStore.js';

export interface ManagedPinRecord {
  cid: string;
  ownership: 'created' | 'preexisting' | 'unknown';
  owners: Record<string, { createdAt: string }>;
  state: 'pending' | 'pinned' | 'release_pending' | 'releasing' | 'release_uncertain' | 'retained' | 'released';
  updatedAt: string;
  reason?: string;
  lastReleasedOwner?: string;
}
export interface PinReleaseResult {
  ownerReleased: boolean;
  pinRemoved: boolean;
  reason?: string;
}

const sharedLocks = new WeakMap<LocalStore, Map<string, Promise<unknown>>>();

/** Pin ownership is durable and shared across archive, spatial and compute callers. */
export class ManagedPins {
  private readonly locks: Map<string, Promise<unknown>>;
  constructor(
    private readonly kubo: Pick<KuboClient, 'pinLs' | 'pinAdd' | 'pinRm'>,
    private readonly store: LocalStore,
    private readonly options: { allowUnpin?: boolean } = {},
  ) {
    this.locks = sharedLocks.get(store) ?? new Map();
    sharedLocks.set(store, this.locks);
  }

  private exclusive<T>(cid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(cid) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    this.locks.set(cid, task);
    return task.finally(() => {
      if (this.locks.get(cid) === task) this.locks.delete(cid);
    });
  }

  private checkOwner(owner: string): void {
    if (
      !/^(?:archive|spatial|requester-input|provider-input|manual):[a-zA-Z0-9_.:-]{1,480}$/.test(
        owner,
      )
    )
      throw new Error('invalid_pin_owner');
  }

  private async probeOwnership(
    cid: string,
  ): Promise<ManagedPinRecord['ownership']> {
    try {
      // A manual direct or indirect reference also predates this owner. Do
      // not mistake it for absence merely because it is not recursive.
      const result = (await this.kubo.pinLs(undefined, 'all')) as {
        Keys?: Record<string, unknown>;
      };
      if (
        !result ||
        !result.Keys ||
        typeof result.Keys !== 'object' ||
        Array.isArray(result.Keys)
      )
        return 'unknown';
      const keys = Object.keys(result.Keys).map(canonicalPinCid);
      return keys.includes(cid) ? 'preexisting' : 'created';
    } catch {
      return 'unknown';
    }
  }

  async acquire(
    raw: string,
    owner: string,
    pin?: (cid: string) => Promise<void>,
  ): Promise<string> {
    const cid = canonicalPinCid(raw);
    this.checkOwner(owner);
    return this.exclusive(cid, async () => {
      const previous = this.store.snapshot().managedPins?.[cid];
      if (previous?.state === 'releasing' || previous?.state === 'release_uncertain') {
        throw new Error('pin_release_outcome_requires_review');
      }
      const ownership =
        // A record still 'pending' may predate a crash: another party could have pinned the
        // CID since, so re-probe. A pin that was already ours then reads as preexisting, which
        // errs toward retaining (never removing) it.
        !previous || previous.state === 'released' || previous.state === 'pending'
          ? await this.probeOwnership(cid)
          : previous.ownership;
      await this.store.update((state) => {
        const current = (state.managedPins ??= {})[cid] ?? {
          cid,
          ownership,
          owners: {},
          state: 'pending',
          updatedAt: new Date().toISOString(),
        };
        current.ownership = ownership;
        current.owners[owner] ??= { createdAt: new Date().toISOString() };
        current.state = 'pending';
        current.reason = undefined;
        current.updatedAt = new Date().toISOString();
        state.managedPins[cid] = current;
      });
      try {
        if (pin) await pin(cid);
        else await this.kubo.pinAdd(cid);
        await this.store.update((state) => {
          const current = state.managedPins![cid]!;
          current.state = 'pinned';
          current.updatedAt = new Date().toISOString();
        });
      } catch (error) {
        await this.store.update((state) => {
          state.managedPins![cid]!.reason = 'pin_acquisition_retry_required';
        });
        throw error;
      }
      return cid;
    });
  }

  async release(raw: string, owner: string): Promise<PinReleaseResult> {
    const cid = canonicalPinCid(raw);
    this.checkOwner(owner);
    return this.exclusive(cid, async () => {
      const record = this.store.snapshot().managedPins?.[cid];
      if (record?.state === 'releasing' || record?.state === 'release_uncertain') {
        throw new Error('pin_release_outcome_requires_review');
      }
      if (
        !record ||
        (!record.owners[owner] && record.state !== 'release_pending')
      )
        return {
          ownerReleased: false,
          pinRemoved: false,
          reason: 'owner_not_registered',
        };
      await this.store.update((state) => {
        const current = state.managedPins![cid]!;
        delete current.owners[owner];
        current.lastReleasedOwner = owner;
        if (!Object.keys(current.owners).length)
          current.state = 'release_pending';
        current.updatedAt = new Date().toISOString();
      });
      return this.releaseUnreferenced(cid);
    });
  }

  private referenced(cid: string, state: LocalState): boolean {
    const same = (raw: unknown) => {
      try {
        return typeof raw === 'string' && canonicalPinCid(raw) === cid;
      } catch {
        return false;
      }
    };
    if (state.desiredCids.some((record) => same(record.cid))) return true;
    for (const item of Object.values(state.spatial || {})) {
      const record = item as {
        manifestCid?: string;
        manifest?: { variants?: Array<{ cid?: string }> };
      };
      if (
        same(record.manifestCid) ||
        record.manifest?.variants?.some((variant) => same(variant.cid))
      )
        return true;
    }
    for (const [value, record] of Object.entries(
      state.privateComputeCids || {},
    )) {
      if (!record.pinOwner && !record.releasedAt && same(value)) return true;
    }
    for (const value of Object.values(state.remoteJobs || {})) {
      const record = value as { cleanup?: { inputCid?: string; pinOwner?: string; inputPinReleasePending?: boolean } };
      if (record.cleanup && !record.cleanup.pinOwner && record.cleanup.inputPinReleasePending !== false && same(record.cleanup.inputCid)) return true;
    }
    return false;
  }

  private async releaseUnreferenced(cid: string): Promise<PinReleaseResult> {
    const state = this.store.snapshot();
    const record = state.managedPins?.[cid];
    if (!record)
      return {
        ownerReleased: false,
        pinRemoved: false,
        reason: 'ownership_unknown',
      };
    if (Object.keys(record.owners).length || this.referenced(cid, state)) {
      return {
        ownerReleased: true,
        pinRemoved: false,
        reason: 'other_references',
      };
    }
    if (record.ownership !== 'created') {
      await this.store.update((next) => {
        next.managedPins![cid]!.state = 'retained';
        next.managedPins![cid]!.reason = 'preexisting_or_unknown_pin';
      });
      return {
        ownerReleased: true,
        pinRemoved: false,
        reason: 'preexisting_or_unknown_pin',
      };
    }
    if (this.options.allowUnpin !== true) {
      if (record.state !== 'release_pending' || record.reason !== 'pin_release_activation_required') {
        await this.store.update(next => {
          next.managedPins![cid]!.state = 'release_pending';
          next.managedPins![cid]!.reason = 'pin_release_activation_required';
        });
      }
      return { ownerReleased: true, pinRemoved: false, reason: 'pin_release_activation_required' };
    }
    await this.store.update(next => {
      next.managedPins![cid]!.state = 'releasing';
      next.managedPins![cid]!.reason = 'pin_release_in_flight';
    });
    try {
      await this.kubo.pinRm(cid);
    } catch (error) {
      const outcome = error as { outcomeUncertain?: boolean; kuboResponseComplete?: boolean };
      if (outcome.outcomeUncertain === true || outcome.kuboResponseComplete !== true) {
        await this.store.update(next => {
          next.managedPins![cid]!.state = 'release_uncertain';
          next.managedPins![cid]!.reason = 'pin_release_outcome_requires_review';
        });
        throw error;
      }
      const message = String((error as Error).message || error).toLowerCase();
      // A generic HTTP 404 or "not found" can describe an unavailable RPC
      // route, not an absent pin. Only Kubo's explicit absent-pin response
      // establishes that no retry is needed.
      if (!message.includes('not pinned')) {
        await this.store.update((next) => {
          next.managedPins![cid]!.state = 'release_pending';
          next.managedPins![cid]!.reason = 'pin_release_retry_required';
        });
        throw error;
      }
    }
    await this.store.update((next) => {
      next.managedPins![cid]!.state = 'released';
      next.managedPins![cid]!.reason = undefined;
      next.managedPins![cid]!.updatedAt = new Date().toISOString();
    });
    return { ownerReleased: true, pinRemoved: true };
  }

  async reconcile({ ownerPrefix }: { ownerPrefix?: string } = {}): Promise<void> {
    let failure: unknown;
    for (const [cid, record] of Object.entries(
      this.store.snapshot().managedPins || {},
    )) {
      if (record.state !== 'release_pending') continue;
      if (ownerPrefix && !record.lastReleasedOwner?.startsWith(ownerPrefix)) continue;
      try { await this.exclusive(cid, () => this.releaseUnreferenced(cid)); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
