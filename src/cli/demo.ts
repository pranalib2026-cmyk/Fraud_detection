#!/usr/bin/env node
/** @module cli/demo — Interactive and scripted walkthrough of the investigation agent.

 * Usage:
 *   npx tsx src/cli/demo.ts                                   interactive prompt
 *   npx tsx src/cli/demo.ts --once --txn 331296 --card C100001 --customer CUST-0000231 --amount 190
 *   npx tsx src/cli/demo.ts --script scenarios/demo.json      scripted sequence of steps
 *
 * The scripted form is what the recorded demo uses: each entry is
 * `{ "description": "...", "args": ["--txn","331296","--card","C100001","--amount","190"] }`.
 *
 * Environment: HHGOA_DEMO_CARD, HHGOA_DEMO_CUSTOMER, HHGOA_DEMO_AMOUNT set the defaults
 * used when a command omits them.
 */

import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { loadEnv, paths } from '../config.js';
import { investigate, stepOnce } from '../agent/index.js';
import { log, parseArgs, triggerFromArgs, intentOf } from './io.js';
import type { InvestigationResult } from '../agent/index.js';

loadEnv();

const DEFAULT_CARD = process.env.HHGOA_DEMO_CARD ?? 'C100001';
const DEFAULT_CUSTOMER = process.env.HHGOA_DEMO_CUSTOMER ?? 'CUST-0000231';
const DEFAULT_AMOUNT = process.env.HHGOA_DEMO_AMOUNT ?? '190.00';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

/** Fill in demo defaults so a bare `investigate` command still works. */
function withDefaults(args: Record<string, any>): Record<string, any> {
  return {
    card: args.card ?? args.card_id ?? DEFAULT_CARD,
    customer: args.customer ?? args.customer_id ?? DEFAULT_CUSTOMER,
    amount: args.amount ?? args.amount_usd ?? DEFAULT_AMOUNT,
    ...args,
  };
}

/** Build a trigger, reporting the problem to the user instead of throwing. */
function tryTrigger(args: Record<string, any>): ReturnType<typeof triggerFromArgs> | null {
  try {
    return triggerFromArgs(args);
  } catch (e: any) {
    log(`⚠ ${e?.message ?? e}`);
    return null;
  }
}

function printResult(result: InvestigationResult, elapsedMs: number): void {
  const line = '─'.repeat(72);
  log('');
  log(line);
  log(`  Case            ${result.case_id}`);
  log(`  Status          ${result.status}`);
  log(`  Fraud prob.     ${result.fraud_probability != null ? result.fraud_probability.toFixed(2) : 'not assessed'}`);
  log(`  Pattern         ${result.assessed_pattern ?? 'none'}`);
  log(`  Backend         ${result.backend_kind}${result.degraded ? '  [DEGRADED — TigerGraph not the source]' : ''}`);
  log(`  Steps/evidence  ${result.steps_count} / ${result.evidence_count}`);
  log(`  Elapsed         ${elapsedMs}ms`);
  log(line);

  if (result.recommendation) {
    const r = result.recommendation;
    log(`  RECOMMENDATION  ${r.action}  (route: ${r.route})`);
    log(`  Reason          ${r.reason}`);
    log(`  Citing rules    ${r.citing_rules.join(', ') || 'none'}`);
  }

  if (result.actions.length) {
    log('');
    log('  ACTIONS');
    for (const a of result.actions) log(`    [${a.status}] ${a.action} via ${a.route || 'n/a'} — ${a.reason}`);
  }

  log('');
  log('  EVIDENCE');
  for (const l of result.evidence_summary.split('\n')) log(`    ${l}`);
  log(line);
  log('');
}

async function runOnce(rawArgs: Record<string, any>): Promise<void> {
  const args = withDefaults(rawArgs);
  const trigger = tryTrigger(args);
  if (!trigger) return;

  log(`\n▶ Investigating txn ${trigger.transaction_id} · card ${trigger.card_id} · customer ${trigger.customer_id}`);
  log(`  trigger=${trigger.type} amount=$${trigger.amount_usd.toFixed(2)} risk=${trigger.risk_score ?? 'n/a'}\n`);

  const started = Date.now();
  const result = await investigate(trigger, intentOf(args));
  printResult(result, Date.now() - started);
}

async function runStep(rawArgs: Record<string, any>): Promise<void> {
  const args = withDefaults(rawArgs);
  const trigger = tryTrigger(args);
  if (!trigger) return;

  log('\n▶ Running one loop step…');
  const started = Date.now();
  const { stopped, result } = await stepOnce(trigger, intentOf(args));
  log(`  stopped=${stopped}`);
  log(`  case=${result.case_id} status=${result.status} p=${result.fraud_probability != null ? result.fraud_probability.toFixed(2) : 'n/a'} steps=${result.steps_count} evidence=${result.evidence_count}`);
  if (result.recommendation) log(`  recommendation=${result.recommendation.action} via ${result.recommendation.route}`);
  log(`  (${Date.now() - started}ms)\n`);
}

function banner(): void {
  log(`
╔════════════════════════════════════════════════════════════════════════════╗
║   TigerGraph Agentic Fraud Investigation — demo                            ║
╠════════════════════════════════════════════════════════════════════════════╣
║   Commands                                                                 ║
║     investigate [flags]   run the loop to a STOP condition                 ║
║     step [flags]          run exactly one loop step                        ║
║     help                  show this help                                   ║
║     quit                  leave the demo                                   ║
║                                                                            ║
║   Flags (investigate / step)                                               ║
║     --txn <id>            transaction id                                   ║
║     --card <id>           card id            (default ${DEFAULT_CARD})         ║
║     --customer <id>       customer id        (default ${DEFAULT_CUSTOMER}) ║
║     --amount <usd>        transaction amount (default ${DEFAULT_AMOUNT})        ║
║     --risk <0-1>          model risk score                                 ║
║     --type <type>         risk_score | customer_report | analyst | case_pack║
║     --desc <text>         trigger description                              ║
║                                                                            ║
║   Examples                                                                 ║
║     investigate --txn 331296 --card C100001                               ║
║     investigate --txn 331296 --card C100001 --risk 0.87 --amount 190      ║
║     investigate --type customer_report --txn 331296 --amount 420          ║
║     step --txn 331296 --amount 190                                        ║
╚════════════════════════════════════════════════════════════════════════════╝

  Backend  ${paths.projection}
  Memory   ${paths.memory}
`);
}

async function interactive(): Promise<void> {
  banner();
  for (;;) {
    const line = await ask('❯ ');
    if (!line) continue;
    const parts = line.split(/\s+/);
    const command = parts[0].toLowerCase();

    if (command === 'quit' || command === 'exit') { log('\nBye.\n'); rl.close(); return; }
    if (command === 'help' || command === '?') { banner(); continue; }

    const args = parseArgs(['node', 'demo', ...parts.slice(1)], 0);
    if (command === 'investigate') await runOnce(args);
    else if (command === 'step') await runStep(args);
    else log(`⚠ unknown command "${command}" — try: investigate, step, help, quit`);
  }
}

async function scripted(file: string): Promise<void> {
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(script)) throw new Error('demo script must be a JSON array of steps');

  log(`\n▶ Scripted demo: ${file} (${script.length} steps)\n`);
  for (let i = 0; i < script.length; i++) {
    const step = script[i];
    log(`\n[${i + 1}/${script.length}] ${step.description ?? 'step'}`);
    const args = parseArgs(['node', 'demo', ...(step.args ?? [])], 0);
    if (step.command === 'step') await runStep({ ...args, ...(step.overrides ?? {}) });
    else await runOnce({ ...args, ...(step.overrides ?? {}) });

    if (i < script.length - 1 && !step.noPause) {
      const go = await ask('  ↵ continue (or type "quit" to stop) ');
      if (go.toLowerCase() === 'quit') break;
    }
  }
  log('\n✔ Scripted demo complete.\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.script) { await scripted(String(args.script)); rl.close(); return; }
  if (args.once) {
    const command = args.step ? runStep : runOnce;
    await command(args);
    rl.close();
    return;
  }
  await interactive();
}

main().catch((e) => {
  log(`\n✖ demo error: ${e?.stack ?? e?.message ?? e}\n`);
  rl.close();
  process.exit(1);
});
