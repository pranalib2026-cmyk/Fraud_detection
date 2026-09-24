#!/usr/bin/env node
/** @module cli/investigate — Run one investigation from the terminal.

 * Usage:
 *   npx tsx src/cli/investigate.ts --txn 331296 --card C100001 --customer CUST-0000231 --amount 190.00
 *   npx tsx src/cli/investigate.ts --txn 331296 --card C100001 --customer CUST-0000231 --risk 0.87 --type risk_score
 *   npx tsx src/cli/investigate.ts --txn 331296 --card C100001 --customer CUST-0000231 --amount 190 --json
 *
 * Environment: HHGOA_MAX_STEPS, HHGOA_MAX_EVIDENCE (or --max-steps / --max-evidence).
 * The result is printed as JSON on stdout so it can be piped; progress goes to stderr.
 */

import { loadEnv, paths } from '../config.js';
import { investigate } from '../agent/index.js';
import { log, parseArgs, triggerFromArgs, intentOf } from './io.js';

loadEnv();

function usage(): never {
  log(`Usage: investigate --txn <id> --card <id> --customer <id> [--amount <usd>] [--risk <0-1>] [options]

Required:
  --txn <id>            transaction id (alias --txn_id)
  --card <id>           card id
  --customer <id>       customer id

At least one of:
  --amount <usd>        transaction amount
  --risk <0-1>          model risk score (alias --score)

Options:
  --type <type>         risk_score | customer_report | analyst | case_pack
  --ts <iso>            trigger timestamp
  --desc <text>         trigger description
  --max-steps <n>       step budget for this run
  --max-evidence <n>    evidence budget for this run
  --quiet               print only the summary block

Environment: PROJECTION_PATH=${paths.projection}  HHGOA_RAW_DIR=${paths.raw}  HHGOA_MEMORY_DIR=${paths.memory}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help || args.h) usage();

  let trigger;
  try {
    trigger = triggerFromArgs(args);
  } catch (e: any) {
    log(`[investigate] ${e?.message ?? e}`);
    return usage();
  }

  if ((args.amount ?? args.amount_usd) === undefined && (args.risk ?? args.risk_score ?? args.score) === undefined) {
    log('[investigate] provide --amount or --risk (or both) so the policy rules have an exposure signal');
    return usage();
  }

  log(`[investigate] trigger=${trigger.transaction_id} card=${trigger.card_id} customer=${trigger.customer_id} type=${trigger.type} amount=${trigger.amount_usd} risk=${trigger.risk_score ?? 'n/a'}`);

  const started = Date.now();
  const result = await investigate(trigger, intentOf(args));
  const elapsed = Date.now() - started;

  if (args.quiet) {
    log(result.summary);
  } else {
    process.stdout.write(`${JSON.stringify({ ...result, elapsed_ms: elapsed }, null, 2)}\n`);
  }

  const p = result.fraud_probability;
  log(`[investigate] case=${result.case_id} status=${result.status} p=${p != null ? p.toFixed(2) : 'n/a'} pattern=${result.assessed_pattern ?? 'none'} steps=${result.steps_count} evidence=${result.evidence_count} backend=${result.backend_kind}${result.degraded ? ' (DEGRADED)' : ''} in ${elapsed}ms`);
}

main().catch((e) => {
  log(`[investigate] fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
