import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isBundleFileName } from '../spatial/models.js';
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

/** One file inside an immutable bundle, as Kubo reports it. */
export interface KuboFileStat {
  /** Content hash of this file alone. Stable, so it doubles as a strong ETag. */
  hash: string;
  /** Exact byte length of the file's contents. */
  sizeBytes: number;
  type: 'file' | 'directory';
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
    // Always recursive, and said so explicitly rather than left to Kubo's default:
    // a flat bundle is a directory, and a direct pin of its root keeps the
    // directory block while its files are garbage collected (the root still lists
    // them; reading them fails).
    return this.post('pin/add', { arg: normalizeCid(cid), recursive: 'true', progress: 'false' });
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

  /**
   * Adds a flat set of files as one immutable directory and returns its root.
   *
   * Streams every file from disk like [addFileStreamed], and wraps them in a
   * directory so the result is a single CID that pins - and releases - the
   * whole bundle as one unit. The listing is flat by contract: names are
   * validated as single path segments before anything is sent, so a name can
   * never create a nested path or climb out of the directory.
   */
  async addDirectoryStreamed(
    directory: string,
    names: string[],
    timeoutMs = 30 * 60 * 1000,
  ): Promise<{ rootCid: string; files: Array<{ name: string; cid: string; sizeBytes: number }> }> {
    if (names.length === 0) throw new Error('kubo_add_directory_empty');
    if (new Set(names).size !== names.length) throw new Error('kubo_add_directory_duplicate_name');
    for (const name of names) if (!isBundleFileName(name)) throw new Error('kubo_add_directory_name_invalid');
    const boundary = `kubusNode${crypto.randomBytes(16).toString('hex')}`;
    const parts: Array<{ header: Buffer; filePath: string; size: number }> = [];
    let total = 0;
    for (const name of names) {
      const filePath = path.join(directory, name);
      const { size } = await stat(filePath);
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(name)}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      );
      parts.push({ header, filePath, size });
      total += header.byteLength + size + 2; // the CRLF that follows every file
    }
    const footer = Buffer.from(`--${boundary}--\r\n`);
    total += footer.byteLength;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = Readable.toWeb(Readable.from(streamMultipartFiles(parts, footer))) as ReadableStream<Uint8Array>;
      const params = new URLSearchParams({ pin: 'true', 'cid-version': '0', 'wrap-with-directory': 'true' });
      const response = await fetch(`${this.apiBase}/add?${params.toString()}`, {
        method: 'POST',
        // @ts-expect-error - Node's fetch (undici) requires `duplex` for a streamed body; not yet in the DOM lib types.
        duplex: 'half',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(total) },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Kubo add failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
      const entries = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as { Name?: string; Hash?: string });
      const root = entries.find((entry) => entry.Name === '');
      if (!root?.Hash) throw new Error('kubo_add_directory_missing_root');
      const sizes = new Map(parts.map((part, index) => [names[index]!, part.size]));
      const files = names.map((name) => {
        const entry = entries.find((candidate) => candidate.Name === name);
        if (!entry?.Hash) throw new Error('kubo_add_directory_missing_file');
        return { name, cid: entry.Hash, sizeBytes: sizes.get(name)! };
      });
      return { rootCid: root.Hash, files };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Stats one file inside an immutable bundle by name, or null when the bundle
   * has no such file. Only a single-segment file name is accepted, so this can
   * never be steered to another path in the DAG.
   */
  async fileStat(rootCid: string, name: string): Promise<KuboFileStat | null> {
    if (!isBundleFileName(name)) throw new Error('kubo_bundle_name_invalid');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url('files/stat', { arg: `/ipfs/${normalizeCid(rootCid)}/${name}` }), { method: 'POST', signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 500 && /does not exist|not found|no link named/i.test(text)) return null;
        throw new Error(`Kubo files/stat failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      const body = JSON.parse(text) as { Hash?: string; Size?: number; Type?: string };
      if (!body.Hash || !Number.isSafeInteger(body.Size)) throw new Error('kubo_files_stat_invalid');
      return { hash: body.Hash, sizeBytes: body.Size as number, type: body.Type === 'directory' ? 'directory' : 'file' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Names directly inside a bundle root. Used to prove a bundle is whole, not to serve it. */
  async listBundle(rootCid: string): Promise<string[]> {
    const response = await this.post<{ Objects?: Array<{ Links?: Array<{ Name?: string }> }> }>('ls', {
      arg: normalizeCid(rootCid), 'resolve-type': 'false', size: 'false',
    });
    return (response.Objects?.[0]?.Links ?? []).map((link) => String(link.Name ?? ''));
  }

  /**
   * True when every block under `cid` is in this node's local store. Never
   * reaches the network.
   *
   * `refs` streams, so Kubo commits `HTTP 200` before it has walked the DAG and
   * reports a missing block as an `Err` inside the body (`{"Ref":"","Err":
   * "block was not found locally ..."}`). Trusting the status code therefore
   * answered "yes" for content that garbage collection had already removed -
   * and a pinned-but-hollow bundle root (the directory block survives a direct
   * pin, its files do not) fails the same way. The body is the answer.
   */
  async hasAllBlocksLocally(cid: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const url = this.url('refs', { arg: normalizeCid(cid), recursive: 'true', unique: 'true', offline: 'true' });
      const response = await fetch(url, { method: 'POST', signal: controller.signal });
      const text = await response.text();
      if (!response.ok) return false;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry: { Err?: unknown };
        try {
          entry = JSON.parse(line) as { Err?: unknown };
        } catch {
          // A line that is not JSON is a stream that did not finish cleanly.
          return false;
        }
        if (typeof entry.Err === 'string' && entry.Err !== '') return false;
      }
      return true;
    } catch {
      return false;
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
    /** A file inside a bundle root; only a single validated file name is accepted. */
    innerFile?: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; cancel: () => void }> {
    const controller = new AbortController();
    if (innerFile !== undefined && !isBundleFileName(innerFile)) throw new Error('kubo_bundle_name_invalid');
    const params: Record<string, string> = { arg: innerFile === undefined ? normalizeCid(cid) : `/ipfs/${normalizeCid(cid)}/${innerFile}` };
    if (range) {
      params.offset = String(range.offset);
      params.length = String(range.length);
    }
    const response = await fetch(this.url('cat', params), { method: 'POST', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Kubo cat failed with HTTP ${response.status}`);
    return { body: response.body, cancel: () => controller.abort() };
  }

  /**
   * Streams a file CID to `destination` on disk without buffering it. Used to
   * bring a preserved master back into a job workspace so a derivative can be
   * regenerated without re-running the reconstruction that made it.
   */
  async catToFile(cid: string, destination: string, timeoutMs = 60 * 60 * 1000): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url('cat', { arg: normalizeCid(cid) }), { method: 'POST', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Kubo cat failed with HTTP ${response.status}`);
      const sink = createWriteStream(destination, { mode: 0o600 });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), sink);
      return (await stat(destination)).size;
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

/** Yields each part's preamble, its file bytes and a CRLF, then the closing boundary. */
async function* streamMultipartFiles(parts: Array<{ header: Buffer; filePath: string }>, footer: Buffer): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part.header;
    const stream = createReadStream(part.filePath);
    try {
      for await (const chunk of stream) yield chunk as Buffer;
    } finally {
      stream.close();
    }
    yield Buffer.from('\r\n');
  }
  yield footer;
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
