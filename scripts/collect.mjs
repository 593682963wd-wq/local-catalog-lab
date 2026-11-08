import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { collect } from '../src/collector.mjs';
import { saveResult, projectRoot } from '../src/storage.mjs';

const { server, origin } = await startServer(0);
try {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'fixtures/manifest.json'), 'utf8'));
  const result = await saveResult(await collect(origin, manifest));
  console.log(JSON.stringify({ run_id: result.run_id, scope: result.scope, summary: result.summary, output: `outputs/runs/${result.run_id}/` }, null, 2));
} finally { server.close(); }
