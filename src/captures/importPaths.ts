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
  const lexical = path.resolve(requested);
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await fs.realpath(root));
    } catch {
      // A root that does not exist holds nothing to import.
    }
  }
  const inside = (candidate: string, base: string) => candidate === base || candidate.startsWith(`${base}${path.sep}`);
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch {
    // Not found: say so only for a path that lies inside an import folder. Anywhere else the answer is the same
    // refusal an existing file there gets, so the route does not tell a caller what exists on the Node's disk.
    if (realRoots.some((base) => inside(lexical, base)) || roots.some((base) => inside(lexical, path.resolve(base)))) {
      throw localError(404, 'import_source_not_found', { message: 'No file at that path in the import folders' });
    }
    throw localError(403, 'import_path_not_allowed', { message: "The file is not inside one of the Node's import folders (the imports folder of its data directory, or a folder listed in KUBUS_IMPORT_DIRS)" });
  }
  if (realRoots.some((base) => inside(real, base))) return real;
  // The folders themselves are not named in the answer (a caller does not need the Node's disk layout); the operator
  // finds them in docs/SPATIAL.md: `<data>/imports` and the folders listed in KUBUS_IMPORT_DIRS.
  throw localError(403, 'import_path_not_allowed', { message: "The file is not inside one of the Node's import folders (the imports folder of its data directory, or a folder listed in KUBUS_IMPORT_DIRS)" });
}
