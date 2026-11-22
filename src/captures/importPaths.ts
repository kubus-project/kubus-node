import { promises as fs } from 'node:fs';
import path from 'node:path';
import { localError } from '../localApi/pairingService.js';

/**
 * Directories a running Node will import local files from.
 *
 * The import route reads a path on the Node's own disk, so it is confined to
 * directories the operator chose: `<data>/imports` (created at start, the place
 * to `docker cp` a clip into) plus any listed in `KUBUS_IMPORT_DIRS`
 * (path-delimiter separated). Anything else - the state directory, the
 * identity files, the rest of the filesystem - is refused.
 */
export function importRoots(localDataPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.KUBUS_IMPORT_DIRS || '').split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  return [path.join(localDataPath, 'imports'), ...extra].map((entry) => path.resolve(entry));
}

export async function ensureImportDirectory(localDataPath: string): Promise<string> {
  const directory = path.join(localDataPath, 'imports');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Resolves a requested file to its real path and proves it sits inside an import root. */
export async function resolveImportSource(requested: unknown, roots: string[]): Promise<string> {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw localError(400, 'import_path_required');
  let real: string;
  try {
    real = await fs.realpath(path.resolve(requested));
  } catch {
    throw localError(404, 'capture_video_source_not_found', { message: 'No file at that path on the Node' });
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) return real;
  }
  // The folders themselves are not named in the answer (a caller does not need the Node's disk layout); the operator
  // finds them in docs/SPATIAL.md: `<data>/imports` and the folders listed in KUBUS_IMPORT_DIRS.
  throw localError(403, 'import_path_not_allowed', { message: "The file is not inside one of the Node's import folders (the imports folder of its data directory, or a folder listed in KUBUS_IMPORT_DIRS)" });
}
