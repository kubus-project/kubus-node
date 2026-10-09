import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeEnvText, readEnvValue, updateEnvFile, withComposeProfile } from '../src/installer/runtimeEnv.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const tempDir = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-env-')); dirs.push(dir); return dir; };

describe('merging into an env file the operator owns', () => {
  const OPERATOR = [
    '# written by me, not by setup',
    'NODE_BIND_ADDRESS=0.0.0.0',
    '',
    'NODE_LAN_URL=http://192.168.1.20:8787',
    'MY_SECRET=p4ss=word with spaces # and a hash',
    "QUOTED='keep me'",
    '#COMMENTED=1',
    'COMPOSE_PROFILES=monitoring',
    '',
  ].join('\n');

  it('changes only the keys it is given and keeps every other line exactly as it was', () => {
    const merged = mergeEnvText(OPERATOR, { NODE_BIND_ADDRESS: '127.0.0.1', KUBUS_SPATIAL_WORKER: 'auto' });
    expect(merged).toBe(OPERATOR.replace('NODE_BIND_ADDRESS=0.0.0.0', 'NODE_BIND_ADDRESS=127.0.0.1') + 'KUBUS_SPATIAL_WORKER=auto\n');
    expect(merged).toContain('MY_SECRET=p4ss=word with spaces # and a hash');
    expect(merged).toContain("QUOTED='keep me'");
    expect(merged).toContain('# written by me, not by setup');
  });

  it('is what finishing setup does to a file that already holds more than the two topology keys', () => {
    const merged = mergeEnvText(OPERATOR, { NODE_BIND_ADDRESS: '127.0.0.1', NODE_LAN_URL: '' });
    expect(readEnvValue(merged, 'MY_SECRET')).toBe('p4ss=word with spaces # and a hash');
    expect(readEnvValue(merged, 'COMPOSE_PROFILES')).toBe('monitoring');
    expect(readEnvValue(merged, 'NODE_LAN_URL')).toBe('');
  });

  it('is idempotent', () => {
    const once = mergeEnvText(OPERATOR, { KUBUS_SPATIAL_WORKER: 'on', SPATIAL_WORKER_URL: '' });
    expect(mergeEnvText(once, { KUBUS_SPATIAL_WORKER: 'on', SPATIAL_WORKER_URL: '' })).toBe(once);
  });

  it('removes a key when told to, and only that key', () => {
    const merged = mergeEnvText(OPERATOR, { COMPOSE_PROFILES: null });
    expect(readEnvValue(merged, 'COMPOSE_PROFILES')).toBeUndefined();
    expect(merged).toContain('NODE_BIND_ADDRESS=0.0.0.0');
    expect(mergeEnvText('A=1\n', { A: null })).toBe('');
    expect(mergeEnvText('', { A: null })).toBe('');
  });

  it('does not mistake a longer name, a comment or a lookalike for the key', () => {
    const text = 'NODE_BIND_ADDRESS_2=keep\n# NODE_BIND_ADDRESS=commented\nXNODE_BIND_ADDRESS=keep\n';
    const merged = mergeEnvText(text, { NODE_BIND_ADDRESS: '127.0.0.1' });
    expect(merged).toBe(`${text}NODE_BIND_ADDRESS=127.0.0.1\n`);
  });

  it('updates the `export KEY=value` form in place', () => {
    expect(mergeEnvText('export KUBUS_SPATIAL_WORKER=off\nOTHER=1\n', { KUBUS_SPATIAL_WORKER: 'on' })).toBe('KUBUS_SPATIAL_WORKER=on\nOTHER=1\n');
  });

  it('collapses a repeated key to one assignment, because Compose honours the last and an update must take effect', () => {
    const merged = mergeEnvText('A=old\nB=1\nA=older\n', { A: 'new' });
    expect(merged).toBe('A=new\nB=1\n');
    expect(readEnvValue(merged, 'A')).toBe('new');
  });

  it('keeps the file\'s own line endings, and writes new lines with them', () => {
    const crlf = 'NODE_BIND_ADDRESS=127.0.0.1\r\nNODE_LAN_URL=\r\n';
    const merged = mergeEnvText(crlf, { NODE_LAN_URL: 'http://10.0.0.5:8787', KUBUS_SPATIAL_WORKER: 'auto' });
    expect(merged).toBe('NODE_BIND_ADDRESS=127.0.0.1\r\nNODE_LAN_URL=http://10.0.0.5:8787\r\nKUBUS_SPATIAL_WORKER=auto\r\n');
    expect(merged.replace(/\r\n/g, '')).not.toContain('\n');
    expect(mergeEnvText('A=1\nB=2\n', { C: '3' })).toBe('A=1\nB=2\nC=3\n');
  });

  it('adds the newline a file was missing before appending', () => {
    expect(mergeEnvText('A=1', { B: '2' })).toBe('A=1\nB=2\n');
    expect(mergeEnvText('', { A: '1' })).toBe('A=1\n');
  });

  it('refuses a key or value that could add a line or need quoting', () => {
    for (const key of ['', '1A', 'A B', 'A=B', 'A\nB', 'A-B', '../x']) expect(() => mergeEnvText('', { [key]: '1' }), JSON.stringify(key)).toThrow(/environment key/);
    for (const value of ['a\nB=2', 'a\rb', 'two words', 'a#b', 'a"b', "a'b", '$HOME', 'a`b', 'a\u0000b', 'a;b']) {
      expect(() => mergeEnvText('', { A: value }), JSON.stringify(value)).toThrow(/unsafe value/);
    }
    for (const value of ['', 'http://192.168.1.20:8787', 'hot,warm', 'spatial', 'a_b-c.d/e@f:g+h=i']) expect(() => mergeEnvText('', { A: value }), value).not.toThrow();
  });
});

describe('reading a value', () => {
  it('returns the last assignment, unquoted, and undefined when there is none', () => {
    const text = '# A=1\nA=first\nB="quoted"\nC=\nA=last\nD=\'single\'\n';
    expect(readEnvValue(text, 'A')).toBe('last');
    expect(readEnvValue(text, 'B')).toBe('quoted');
    expect(readEnvValue(text, 'C')).toBe('');
    expect(readEnvValue(text, 'D')).toBe('single');
    expect(readEnvValue(text, 'MISSING')).toBeUndefined();
    expect(readEnvValue('A=1\r\nB=2\r\n', 'B')).toBe('2');
  });
});

describe('compose profiles', () => {
  it('adds and removes one profile and leaves the operator\'s others alone', () => {
    expect(withComposeProfile(undefined, 'spatial', true)).toBe('spatial');
    expect(withComposeProfile('monitoring', 'spatial', true)).toBe('monitoring,spatial');
    expect(withComposeProfile('monitoring,spatial', 'spatial', true)).toBe('monitoring,spatial');
    expect(withComposeProfile('spatial,monitoring', 'spatial', false)).toBe('monitoring');
    expect(withComposeProfile('spatial', 'spatial', false)).toBeNull();
    expect(withComposeProfile(' a , spatial ,, b ', 'spatial', false)).toBe('a,b');
    expect(withComposeProfile('', 'spatial', false)).toBeNull();
  });
});

describe('writing the file', () => {
  it('creates it owner-only, and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'runtime.env');
    expect(await updateEnvFile(file, { NODE_BIND_ADDRESS: '127.0.0.1', NODE_LAN_URL: '' })).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('NODE_BIND_ADDRESS=127.0.0.1\nNODE_LAN_URL=\n');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['runtime.env']);
  });

  it('upgrades a file written by an earlier release without losing its keys', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'runtime.env');
    await fs.writeFile(file, 'NODE_BIND_ADDRESS=0.0.0.0\r\nNODE_LAN_URL=http://192.168.1.20:8787\r\n');
    await updateEnvFile(file, { KUBUS_SPATIAL_WORKER: 'auto', KUBUS_SPATIAL_WORKER_STATE: 'no_nvidia_gpu' });
    expect(await fs.readFile(file, 'utf8')).toBe('NODE_BIND_ADDRESS=0.0.0.0\r\nNODE_LAN_URL=http://192.168.1.20:8787\r\nKUBUS_SPATIAL_WORKER=auto\r\nKUBUS_SPATIAL_WORKER_STATE=no_nvidia_gpu\r\n');
  });

  it('does not rewrite a file that would not change', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'runtime.env');
    await fs.writeFile(file, 'A=1\n');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await updateEnvFile(file, { A: '1' })).toBe(false);
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it('refuses an unsafe update before touching the file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'runtime.env');
    await fs.writeFile(file, 'KEEP=me\n');
    await expect(updateEnvFile(file, { A: 'x\nEVIL=1' })).rejects.toThrow(/unsafe value/);
    expect(await fs.readFile(file, 'utf8')).toBe('KEEP=me\n');
    expect(await fs.readdir(dir)).toEqual(['runtime.env']);
  });

  it('surfaces a real read error instead of treating it as "no file" and overwriting it', async () => {
    const dir = await tempDir();
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    await fs.mkdir(path.join(dir, 'runtime.env'));
    await expect(updateEnvFile(path.join(dir, 'runtime.env'), { A: '1' })).rejects.toThrow();
  });
});
