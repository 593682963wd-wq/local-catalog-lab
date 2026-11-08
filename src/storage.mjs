import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from './pipeline.mjs';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const outputsRoot = path.join(projectRoot, 'outputs');

export async function saveResult(result) {
  const dir = path.join(outputsRoot, 'runs', result.run_id);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'items.json'), JSON.stringify(result, null, 2) + '\n'),
    writeFile(path.join(dir, 'items.csv'), toCsv(result)),
    writeFile(path.join(dir, 'summary.json'), JSON.stringify({ run_id: result.run_id, ...result.summary }, null, 2) + '\n')
  ]);
  const temp = path.join(outputsRoot, `latest-${result.run_id}.tmp`);
  await writeFile(temp, JSON.stringify({ run_id: result.run_id }, null, 2) + '\n');
  await rename(temp, path.join(outputsRoot, 'latest.json'));
  return result;
}

export function validRunId(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? ''); }

export async function latestResult() {
  try {
    const pointer = JSON.parse(await readFile(path.join(outputsRoot, 'latest.json'), 'utf8'));
    if (!validRunId(pointer.run_id)) throw new Error('结果索引不合法');
    return JSON.parse(await readFile(path.join(outputsRoot, 'runs', pointer.run_id, 'items.json'), 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
