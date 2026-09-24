#!/usr/bin/env node
/** @module cli/evaluate — Score investigation runs against the case pack's ground truth.

 * Usage:
 *   npx tsx src/cli/evaluate.ts                       # auto-locate data/raw case pack
 *   npx tsx src/cli/evaluate.ts --pack <case_pack.csv> --limit 50
 *   npx tsx src/cli/evaluate.ts --closed-cases <closed_cases_history.csv> --max-steps 12
 *
 * Writes under outputs/evaluation/<run_id>/:
 *   report.json    the full EvaluationReport
 *   report.md      the same report rendered as Markdown for the submission bundle
 *   runs.jsonl     one EvaluatedRun per row, appended as the run progresses
 *
 * The recorded outcome in the pack is never passed to the agent — triggers carry only the
 * transaction/card/customer ids, amount and risk score. The outcome is joined here, after
 * the run, to score the result. See evaluator/labels.ts.
 *
 * Environment:
 *   EVAL_RUN_ID            run id (default eval-<epoch>)
 *   EVAL_LIMIT             stop after N rows (smoke runs)
 *   EVAL_MAX_STEPS / EVAL_MAX_EVIDENCE
 *   HHGOA_CASE_PACK        explicit case pack path (same knob the labels module honours)
 *   HHGOA_CLOSED_CASES     explicit closed-case history path
 */

import fs from 'node:fs';
import path from 'node:path';

import { selectBackend } from '../graph/select.js';
import { loadEnv, paths } from '../config.js';
import { appendJsonl, log, parseArgs, writeJson } from './io.js';
import {
  classify, distribution, findCasePack, labelIndex, latencyStats, loadCasePack,
  loadClosedCaseLabels, patternAgreement, policyCheck, processScore, rates,
  renderMarkdown, ruleCitations, runEvaluation, type EvaluationReport, type EvaluatedRun,
  type LabeledOutcome,
} from '../evaluator/index.js';

loadEnv();

const RUN_ID = process.env.EVAL_RUN_ID ?? `eval-${Date.now()}`;
const OUT_DIR = path.join(paths.outputs, 'evaluation', RUN_ID);

/**
 * The runner joins labels by card_id (the case id is generated per run, so it cannot join
 * back to the dataset). The metrics join by case_id, so re-key after the runs complete.
 */
function labelsByCaseId(runs: EvaluatedRun[], byCard: Map<string, LabeledOutcome>): Map<string, LabeledOutcome> {
  const out = new Map<string, LabeledOutcome>();
  for (const run of runs) {
    const label = byCard.get(run.card_id);
    if (label) out.set(run.case_id, label);
  }
  return out;
}

function buildReport(input: {
  pack: string | null;
  packRows: number;
  labelSource: string;
  byCard: Map<string, LabeledOutcome>;
  runs: EvaluatedRun[];
  latencies: number[];
  limit: number | null;
  maxSteps: number;
  configuration: Record<string, unknown>;
}): EvaluationReport {
  const { pack, packRows, labelSource, byCard, runs, latencies, limit, maxSteps, configuration } = input;
  const labels = labelsByCaseId(runs, byCard);
  const classified = classify(runs, labels);

  return {
    generated_at: new Date().toISOString(),
    pack,
    label_source: labelSource,
    limit,
    totals: {
      cases_in_pack: packRows,
      runs: runs.length,
      labeled: classified.true_positive + classified.true_negative + classified.false_positive + classified.false_negative,
      unlabeled: classified.unlabeled,
      errors: runs.filter((r) => r.error).length,
    },
    classification: classified,
    rates: rates(classified),
    pattern_agreement: patternAgreement(runs, labels),
    process: processScore(runs, maxSteps),
    latency_ms: latencyStats(latencies),
    recommendation_distribution: distribution(runs, (r) => r.recommendation),
    route_distribution: distribution(runs, (r) => r.route),
    status_distribution: distribution(runs, (r) => (r.error ? 'error' : 'ok')),
    rule_citations: ruleCitations(runs),
    policy_inconsistencies: runs.map(policyCheck).filter((w) => !w.consistent),
    configuration,
  };
}


async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    log('Usage: evaluate [--pack <case_pack.csv>] [--closed-cases <file>] [--limit N] [--max-steps N] [--max-evidence N]');
    log('Environment: EVAL_RUN_ID, EVAL_LIMIT, EVAL_MAX_STEPS, EVAL_MAX_EVIDENCE, HHGOA_CASE_PACK, HHGOA_CLOSED_CASES');
    process.exit(0);
  }

  const packFile = findCasePack(args.pack ? String(args.pack) : undefined);
  if (!packFile) {
    log('[evaluate] no case pack found — pass --pack <file> or set HHGOA_CASE_PACK (looked in data/raw/)');
    process.exit(2);
  }

  const allRows = loadCasePack(packFile);
  const limitEnv = process.env.EVAL_LIMIT ? Number(process.env.EVAL_LIMIT) : null;
  const limit = args.limit !== undefined ? Number(args.limit) : limitEnv;
  const rows = limit !== null && Number.isFinite(limit) ? allRows.slice(0, limit) : allRows;
  if (!rows.length) {
    log(`[evaluate] ${packFile} yielded no usable rows (need transaction_id / card_id / customer_id columns)`);
    process.exit(2);
  }

  const maxSteps = args.max_steps !== undefined ? Number(args.max_steps)
    : process.env.EVAL_MAX_STEPS ? Number(process.env.EVAL_MAX_STEPS) : 12;
  const maxEvidence = args.max_evidence !== undefined ? Number(args.max_evidence)
    : process.env.EVAL_MAX_EVIDENCE ? Number(process.env.EVAL_MAX_EVIDENCE) : undefined;

  // Labels: the case pack first, then closed-case history. The supplied pack carries no
  // outcome column (the answer key is withheld), so in practice the closed-case history
  // is what labels a card — closed-case labels must therefore be able to fill the nulls.
  const byCard = labelIndex(allRows);
  let labelSource = 'case pack outcomes';
  const closedCandidates = args.closed_cases
    ? [String(args.closed_cases)]
    : [
        process.env.HHGOA_CLOSED_CASES,
        path.join(paths.raw, 'closed_cases_history.csv'),
        path.join(paths.raw, 'closed_cases.csv'),
      ].filter(Boolean) as string[];
  const closedFile = closedCandidates.find((f) => fs.existsSync(f));
  if (closedFile) {
    const closed = loadClosedCaseLabels(closedFile);
    let filled = 0;
    for (const [card, label] of closed) {
      const existing = byCard.get(card);
      if (!existing || (existing.expected_fraud === null && label.expected_fraud !== null)) {
        byCard.set(card, label);
        filled++;
      }
    }
    labelSource = filled
      ? `case pack outcomes + closed-case history (${path.basename(closedFile)})`
      : 'case pack outcomes';
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const backend = await selectBackend();
  const runsFile = path.join(OUT_DIR, 'runs.jsonl');
  log(`[evaluate] run_id=${RUN_ID} pack=${packFile}\n[evaluate] rows=${rows.length}/${allRows.length} labels=${byCard.size} max_steps=${maxSteps} backend=${backend.kind} degraded=${backend.degraded}\n[evaluate] out=${OUT_DIR}`);

  const { runs, latencies } = await runEvaluation(rows, byCard, {
    backend,
    maxSteps,
    maxEvidence,
    onProgress: ({ index, total, run }) => {
      appendJsonl(runsFile, run);
      if ((index + 1) % 10 === 0 || index === total - 1 || run.error) {
        log(`[evaluate] ${index + 1}/${total} ${run.case_id} p=${run.fraud_probability ?? 'n/a'} rec=${run.recommendation ?? 'none'} ${run.elapsed_ms}ms${run.error ? ` ERROR=${run.error}` : ''}`);
      }
    },
  });

  const report = buildReport({
    pack: packFile,
    packRows: allRows.length,
    labelSource,
    byCard,
    runs,
    latencies,
    limit,
    maxSteps,
    configuration: {
      max_steps: maxSteps,
      max_evidence: maxEvidence ?? null,
      run_id: RUN_ID,
      limit,
      closed_cases: closedFile ?? null,
    },
  });

  writeJson(path.join(OUT_DIR, 'report.json'), report);
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), renderMarkdown(report), 'utf8');

  const r = report.rates;
  log(`[evaluate] done runs=${report.totals.runs} labeled=${report.totals.labeled} errors=${report.totals.errors}`);
  log(`[evaluate] accuracy=${r.accuracy ?? 'n/a'} precision=${r.precision ?? 'n/a'} recall=${r.recall ?? 'n/a'} f1=${r.f1 ?? 'n/a'}`);
  log(`[evaluate] process_grade=${report.process.grade ?? 'n/a'} policy_warnings=${report.policy_inconsistencies.length} → ${OUT_DIR}`);
}

main().catch((e) => {
  log(`[evaluate] fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
