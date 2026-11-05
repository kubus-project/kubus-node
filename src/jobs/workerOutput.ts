import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Resolve an output file without following an output/root junction into private inputs. */
export async function resolveWorkerOutputFile(root: string, relative: string): Promise<string> {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error('worker_output_path_invalid');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || ['dataset', 'training', 'raw', 'input', 'inputs'].includes(parts[0]!.toLowerCase())) {
    throw new Error('worker_output_path_invalid');
  }
  if (!/\.(?:ply|spz|splat|sog|glb|gltf)$/i.test(relative)) throw new Error('worker_output_format_invalid');
  const resolvedRoot = path.resolve(root);
  if (await fs.realpath(resolvedRoot) !== resolvedRoot || (await fs.lstat(resolvedRoot)).isSymbolicLink()) {
    throw new Error('worker_output_path_invalid');
  }
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || await fs.realpath(current) !== current ||
        (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error('worker_output_path_invalid');
    }
  }
  return current;
}
