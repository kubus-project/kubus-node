import { Buffer } from 'node:buffer';
import { normalizeCid } from '../utils/cid.js';

export interface KuboId {
  ID: string;
  Addresses?: string[];
  AgentVersion?: string;
  ProtocolVersion?: string;
}

export interface KuboVersion {
  Version: string;
}

export interface RepoStat {
  RepoSize?: number;
  StorageMax?: number;
  NumObjects?: number;
  RepoPath?: string;
}

export class KuboClient {
  private readonly apiBase: string;

  constructor(rpcUrl: string, private readonly timeoutMs = 10000) {
    const normalized = rpcUrl.replace(/\/+$/, '');
    this.apiBase = normalized.endsWith('/api/v0') ? normalized : `${normalized}/api/v0`;
  }

  id(): Promise<KuboId> {
    return this.post<KuboId>('id');
  }

  version(): Promise<KuboVersion> {
    return this.post<KuboVersion>('version');
  }

  repoStat(): Promise<RepoStat> {
    return this.post<RepoStat>('repo/stat');
  }

  async pinAdd(cid: string): Promise<unknown> {
    return this.post('pin/add', { arg: normalizeCid(cid), progress: 'false' });
  }

  async addBytes(bytes: Uint8Array, filename: string): Promise<{ Hash?: string }> {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from(bytes)]), filename);
    return this.postForm('add', form, { pin: 'true', 'cid-version': '0' });
  }

  async pinLs(cid?: string): Promise<unknown> {
    const params: Record<string, string> = { type: 'recursive' };
    if (cid) params.arg = normalizeCid(cid);
    return this.post('pin/ls', params);
  }

  async blockStat(cid: string): Promise<unknown> {
    return this.post('block/stat', { arg: normalizeCid(cid) });
  }

  async catHead(cid: string, length = 1): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = this.url('cat', { arg: normalizeCid(cid), length: String(length) });
      const response = await fetch(url, { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error(`Kubo cat failed with HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(command: string, params: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url(command, params), { method: 'POST', signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(`Kubo ${command} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postForm<T>(command: string, form: FormData, params: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url(command, params), { method: 'POST', body: form, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(`Kubo ${command} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private url(command: string, params: Record<string, string>): string {
    const qs = new URLSearchParams(params);
    return `${this.apiBase}/${command}${qs.toString() ? `?${qs.toString()}` : ''}`;
  }
}
