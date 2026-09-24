/**
 * CLI: build the local graph projection from the raw dataset.
 *
 * Usage: npm run build-graph
 */
import { buildProjection, projectionPath } from './projection.js';
import { paths, requireRawDataset } from '../../config.js';

const rawDir = requireRawDataset();
const outFile = projectionPath(paths.data);

const started = Date.now();
const result = await buildProjection({
  rawDir,
  outFile,
  onProgress: (msg: string) => console.log(`[build-graph] ${msg}`),
});

console.log(JSON.stringify({ ...result, seconds: ((Date.now() - started) / 1000).toFixed(1) }, null, 2));
