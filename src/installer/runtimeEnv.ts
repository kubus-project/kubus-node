import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Editing `runtime.env` without owning it.
 *
 * The file is the operator's, not the installer's. It starts with the two keys
 * setup needs, but an operator (or a later release) may add anything Compose
 * reads from it: a profile, a port, a credential. `writeTopology` used to write
 * the file whole, so finishing setup erased every other key. These functions
 * change only the keys they are asked to change and leave everything else -
 * comments, blank lines, unknown keys, secrets, order, line endings - exactly
 * as found.
 *
 * Values are restricted to a plain alphabet, which is all the installer ever
 * writes. It means there is nothing to quote or escape, and nothing an update
 * can use to smuggle a second line into the file.
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:/@,+=-]*$/;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** A string sets the key; `null` removes it. */
export type EnvUpdates = Record<string, string | null>;

function validate(updates: EnvUpdates): void {
  for (const [key, value] of Object.entries(updates)) {
    if (!KEY.test(key)) throw new Error(`Refusing to write an environment key named ${JSON.stringify(key)}.`);
    if (value !== null && !SAFE_VALUE.test(value)) throw new Error(`Refusing to write an unsafe value for ${key}.`);
  }
}

function eolOf(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** The value of `key` as Compose would read it (the last assignment wins), or undefined. */
export function readEnvValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line);
    if (match && match[1] === key) found = match[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return found;
}

/**
 * `text` with `updates` applied and nothing else changed.
 *
 * A key that appears more than once is collapsed to one assignment at the
 * position of its first occurrence (Compose honours the last, so leaving the
 * older ones would make an update appear not to take). A new key is appended.
 */
export function mergeEnvText(text: string, updates: EnvUpdates): string {
  validate(updates);
  const eol = eolOf(text);
  const pending = new Map(Object.entries(updates));
  const placed = new Set<string>();
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  // A trailing newline yields one empty final element; it is restored below.
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    const match = ASSIGNMENT.exec(line);
    const key = match?.[1];
    if (key === undefined || !pending.has(key)) { out.push(line); continue; }
    if (placed.has(key)) continue; // a duplicate of a key already written
    placed.add(key);
    const value = pending.get(key);
    if (value !== null && value !== undefined) out.push(`${key}=${value}`);
  }
  for (const [key, value] of pending) {
    if (!placed.has(key) && value !== null) out.push(`${key}=${value}`);
  }
  return out.length === 0 ? '' : `${out.join(eol)}${eol}`;
}

/** Adds or removes one profile from a comma-separated COMPOSE_PROFILES value, keeping the others. */
export function withComposeProfile(current: string | undefined, profile: string, enabled: boolean): string | null {
  const profiles = (current ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).filter((entry) => entry !== profile);
  if (enabled) profiles.push(profile);
  return profiles.length > 0 ? profiles.join(',') : null;
}

/**
 * Applies `updates` to the file at `file`, creating it if it does not exist.
 * Written to a sibling and renamed over the original, so a crash leaves either
 * the old file or the new one, never half of one; owner-only, because it can
 * hold whatever the operator put there.
 */
export async function updateEnvFile(file: string, updates: EnvUpdates): Promise<boolean> {
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = mergeEnvText(current, updates);
  if (next === current) return false;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}
