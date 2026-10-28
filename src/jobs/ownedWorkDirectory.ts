import { promises as fs } from 'node:fs';
import path from 'node:path';
export const jobIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Delete only a computed, owned job namespace, never an arbitrary saved path. */
export async function removeOwnedWorkDirectory(
  dataRoot: string,
  namespace: 'jobs' | 'remote-jobs',
  jobId: string,
): Promise<void> {
  if (!jobIdPattern.test(jobId) || !['jobs', 'remote-jobs'].includes(namespace))
    throw new Error('cleanup_path_not_owned');
  const root = await fs.realpath(dataRoot);
  let current = root;
  for (const part of ['private', namespace, jobId]) {
    current = path.join(current, part);
    const info = await fs.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) break;
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await fs.realpath(current)) !== current
    )
      throw new Error('cleanup_path_not_owned');
  }
  const target = path.resolve(root, 'private', namespace, jobId);
  if (!target.startsWith(`${root}${path.sep}`))
    throw new Error('cleanup_path_outside_root');
  await fs.rm(target, { recursive: true, force: true });
}
