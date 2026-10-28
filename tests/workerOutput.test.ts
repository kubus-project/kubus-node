import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { resolveWorkerOutputFile } from '../src/jobs/workerOutput.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-output-')); roots.push(root); return root; }
it('accepts regular generated output', async () => {
 const root = await fixture(); await fs.mkdir(path.join(root, 'export')); const target = path.join(root, 'export', 'result.ply');
 await fs.writeFile(target, 'synthetic'); expect(await resolveWorkerOutputFile(root, 'export/result.ply')).toBe(target);
});
it.each(['../capture.ply', '/capture.ply', 'dataset/private.ply', 'training/private.ply', 'raw/private.ply', 'input/private.ply', 'export/result.jpg', 'export/../result.ply', 'export//result.ply'])('rejects raw/input/traversal or unsupported output %s', async relative => {
 const root = await fixture(); await expect(resolveWorkerOutputFile(root, relative)).rejects.toThrow();
});
it('rejects a nested junction that points into a capture', async () => {
 const root = await fixture(); const outputs = path.join(root, 'outputs'); const capture = path.join(root, 'capture');
 await fs.mkdir(outputs); await fs.mkdir(capture); await fs.writeFile(path.join(capture, 'private.ply'), 'synthetic');
 await fs.symlink(capture, path.join(outputs, 'export'), process.platform === 'win32' ? 'junction' : 'dir');
 await expect(resolveWorkerOutputFile(outputs, 'export/private.ply')).rejects.toThrow('worker_output_path_invalid');
});
it('rejects a job root that is itself a junction', async () => {
 const root = await fixture(); const capture = path.join(root, 'capture'); await fs.mkdir(capture); await fs.writeFile(path.join(capture, 'private.ply'), 'synthetic');
 const alias = path.join(root, 'outputs'); await fs.symlink(capture, alias, process.platform === 'win32' ? 'junction' : 'dir');
 await expect(resolveWorkerOutputFile(alias, 'private.ply')).rejects.toThrow('worker_output_path_invalid');
});
