import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
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

  async pinRm(cid: string): Promise<unknown> {
    return this.post('pin/rm', { arg: normalizeCid(cid), recursive: 'true' });
  }

  async addBytes(bytes: Uint8Array, filename: string): Promise<{ Hash?: string }> {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from(bytes)]), filename);
    return this.postForm('add', form, { pin: 'true', 'cid-version': '0' });
  }

  /**
   * Adds a file to Kubo by streaming it from disk, never holding the whole
   * file in JS memory. `addBytes` requires the caller to already have the
   * full file as an in-memory buffer, which is fine for small manifests but
   * not for a multi-hundred-megabyte Gaussian splat PLY - one large job
   * output would otherwise be read into a single Buffer just to re-emit it
   * as multipart form data.
   *
   * Hand-rolls the multipart body because the standard `FormData`/`Blob`
   * APIs require the whole part in memory up front; a raw streamed fetch
   * body (`duplex: 'half'`) is the only way to keep this bounded.
   */
  async addFileStreamed(filePath: string, filename: string, timeoutMs = 30 * 60 * 1000): Promise<{ Hash?: string }> {
    const { size } = await stat(filePath);
    const boundary = `kubusNode${crypto.randomBytes(16).toString('hex')}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(filename)}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = Readable.toWeb(Readable.from(streamMultipartFile(header, filePath, footer))) as ReadableStream<Uint8Array>;
      const params = new URLSearchParams({ pin: 'true', 'cid-version': '0' });
      const response = await fetch(`${this.apiBase}/add?${params.toString()}`, {
        method: 'POST',
        // @ts-expect-error - Node's fetch (undici) requires `duplex` for a streamed body; not yet in the DOM lib types.
        duplex: 'half',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(header.byteLength + size + footer.byteLength),
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Kubo add failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as { Hash?: string };
    } finally {
      clearTimeout(timeout);
    }
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

  async cat(cid: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60000));
    try {
      const response = await fetch(this.url('cat', { arg: normalizeCid(cid) }), { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error(`Kubo cat failed with HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Streams a CID's bytes without buffering them in Node memory, optionally
   * restricted to a byte range. A Spatial archive can be a multi-hundred-
   * megabyte Gaussian splat PLY; a GUI viewer serving that through `cat()`
   * (which awaits the whole `arrayBuffer()`) would hold the entire file in
   * memory just to re-emit it once. Kubo's `cat` RPC already accepts
   * `offset`/`length`, so a caller answering an HTTP Range request can pass
   * them straight through instead of slicing a buffered response.
   *
   * The caller owns cancellation: call `.cancel()` on the returned handle
   * (e.g. when the client disconnects) to abort the upstream Kubo request
   * rather than reading it to completion for nothing.
   */
  async catStream(
    cid: string,
    range?: { offset: number; length: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; cancel: () => void }> {
    const controller = new AbortController();
    const params: Record<string, string> = { arg: normalizeCid(cid) };
    if (range) {
      params.offset = String(range.offset);
      params.length = String(range.length);
    }
    const response = await fetch(this.url('cat', params), { method: 'POST', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Kubo cat failed with HTTP ${response.status}`);
    return { body: response.body, cancel: () => controller.abort() };
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

/** Yields the multipart preamble, the file's bytes in disk-read-sized chunks, then the closing boundary. */
async function* streamMultipartFile(header: Buffer, filePath: string, footer: Buffer): AsyncGenerator<Buffer> {
  yield header;
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      yield chunk as Buffer;
    }
  } finally {
    stream.close();
  }
  yield footer;
}
