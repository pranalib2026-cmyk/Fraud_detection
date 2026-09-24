#!/usr/bin/env node
/** @module cli/benchmark — Run the investigation loop over many triggers.

 * Usage:
 *   npx tsx src/cli/benchmark.ts --file data/raw/HHGOA_IEEE/case_pack.csv
 *   npx tsx src/cli/benchmark.ts --stream triggers.jsonl
 *   npx tsx src/cli/benchmark.ts --txn 331296 --card C100001 --customer CUST-0000231 --amount 190
 *
 * Writes under outputs/benchmark/<run_id>/, appending results.jsonl as it goes so a
 * long run is inspectable while it is still going:
 *   results.jsonl   one record per trigger
 *   results.json    the same records as a single array
 *   summary.json    aggregates (latency percentiles, recommendation distribution)
 *   slow-log.jsonl  records that exceeded the slow threshold
 *
 * Environment:
 *   BENCHMARK_RUN_ID        run id (default bench-<epoch>)
 *   BENCHMARK_LIMIT         stop after N triggers (smoke runs)
 *   BENCHMARK_THRESHOLD_MS  slow-call threshold (default 60000)
 *   BENCHMARK_MAX_STEPS / BENCHMARK_MAX_EVIDENCE
 *   BENCHMARK_STOP_FILE     create this file to abort a long run
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, paths } from '../config.js';
import { investigate } from '../agent/index.js';
import { selectBackend } from '../graph/select.js';
import { appendJsonl, log, parseArgs, triggerFromArgs, triggersFromCsv, triggersFromJsonl, writeJson } from './io.js';
import { errorRecord, summarize, toRecord, type BenchRecord } from './benchmark-stats.js';
import type { Trigger } from '../core/types.js';

loadEnv();

const RUN_ID = process.env.BENCHMARK_RUN_ID ?? `bench-${Date.now()}`;
const OUT_DIR = path.join(paths.outputs, 'benchmark', RUN_ID);
const SLOW_MS = Number(process.env.BENCHMARK_THRESHOLD_MS ?? 60_000);
const LIMIT = process.env.BENCHMARK_LIMIT ? Number(process.env.BENCHMARK_LIMIT) : Infinity;
const STOP_FILE = process.env.BENCHMARK_STOP_FILE ?? path.join(paths.outputs, `.bench-stop-${RUN_ID}`);

async function resolveTriggers(args: Record<string, any>): Promise<{ triggers: Trigger[]; label: string }> {
  if (args.file) {
    return { triggers: triggersFromCsv(String(args.file)).slice(0, LIMIT), label: `csv:${path.basename(String(args.file))}` };
  }
  if (args.stream) {
    return { triggers: (await triggersFromJsonl(String(args.stream))).slice(0, LIMIT), label: `jsonl:${path.basename(String(args.stream))}` };
  }
  return { triggers: [triggerFromArgs(args)].slice(0, LIMIT), label: 'cli' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const hasTrigger = Boolean(args.file || args.stream || args.txn || args.txn_id || args.transaction_id);
  if (args.help || args.h || !hasTrigger) {
    log('Usage: benchmark --file <case_pack.csv> | --stream <triggers.jsonl> | --txn <id> --card <id> --customer <id> [--amount <usd>]');
    log('Environment: BENCHMARK_RUN_ID, BENCHMARK_LIMIT, BENCHMARK_THRESHOLD_MS, BENCHMARK_MAX_STEPS, BENCHMARK_MAX_EVIDENCE, BENCHMARK_STOP_FILE');
    process.exit(args.help || args.h ? 0 : 2);
  }

  const { triggers, label } = await resolveTriggers(args);
  if (!triggers.length) {
    log('[benchmark] no usable triggers found — check that the file has transaction_id / card_id / customer_id columns');
    process.exit(2);
  }

  const backend = await selectBackend();
  const options = {
    backend,
    maxSteps: args.max_steps !== undefined ? Number(args.max_steps)
      : process.env.BENCHMARK_MAX_STEPS ? Number(process.env.BENCHMARK_MAX_STEPS) : undefined,
    maxEvidence: args.max_evidence !== undefined ? Number(args.max_evidence)
      : process.env.BENCHMARK_MAX_EVIDENCE ? Number(process.env.BENCHMARK_MAX_EVIDENCE) : undefined,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const resultsFile = path.join(OUT_DIR, 'results.jsonl');
  const slowFile = path.join(OUT_DIR, 'slow-log.jsonl');

  log(`[benchmark] run_id=${RUN_ID} label=${label} triggers=${triggers.length} backend=${backend.kind} degraded=${backend.degraded}\n[benchmark] out=${OUT_DIR}\n[benchmark] create ${STOP_FILE} to abort`);

  const records: BenchRecord[] = [];
  for (let i = 0; i < triggers.length; i++) {
    if (fs.existsSync(STOP_FILE)) {
      log(`[benchmark] stop file present — halting after ${i} triggers`);
      break;
    }

    const trigger = triggers[i];
    const started = Date.now();
    let record: BenchRecord;
    try {
      record = toRecord(trigger, await investigate(trigger, options), Date.now() - started);
    } catch (e: any) {
      record = errorRecord(trigger, e?.message ?? String(e), Date.now() - started);
    }

    records.push(record);
    appendJsonl(resultsFile, record);
    if (record.elapsed_ms > SLOW_MS) appendJsonl(slowFile, { ...record, flagged: 'slow' });

    const last = i === triggers.length - 1;
    if ((i + 1) % 25 === 0 || last || record.error) {
      log(`[benchmark] ${i + 1}/${triggers.length} ${record.case_id} ${record.status} ${record.elapsed_ms}ms${record.elapsed_ms > SLOW_MS ? ' SLOW' : ''}${record.error ? ` ERROR=${record.error}` : ''}`);
    }
  }

  const summary = summarize(records, {
    run_id: RUN_ID,
    label,
    generated_at: new Date().toISOString(),
    out_dir: OUT_DIR,
    slow_count: records.filter((r) => r.elapsed_ms > SLOW_MS).length,
    backend: records.length ? undefined : undefined,
    configuration: { backend_kind: backend.kind, degraded: backend.degraded, ...options, slow_threshold_ms: SLOW_MS, limit: Number.isFinite(LIMIT) ? LIMIT : null },
  });

  writeJson(path.join(OUT_DIR, 'results.json'), records);
  writeJson(path.join(OUT_DIR, 'summary.json'), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  log(`[benchmark] done total=${summary.total} errors=${summary.errors} p95=${(summary.latency_ms as any).p95}ms → ${OUT_DIR}`);
}

main().catch((e) => {
  log(`[benchmark] fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
