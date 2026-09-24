import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  findCasePack, labelIndex, loadCasePack, loadClosedCaseLabels, outcomeToBoolean,
} from '../src/evaluator/labels.js';
import { triggerFor } from '../src/evaluator/runner.js';

describe('outcomeToBoolean', () => {
  it('maps the dataset’s recorded outcomes', () => {
    expect(outcomeToBoolean('confirmed_fraud')).toBe(true);
    expect(outcomeToBoolean('no_fraud')).toBe(false);
    expect(outcomeToBoolean('')).toBe(null);
    expect(outcomeToBoolean(null)).toBe(null);
    expect(outcomeToBoolean(undefined)).toBe(null);
  });

  it('falls back to keywords for free-text outcomes', () => {
    expect(outcomeToBoolean('Confirmed Fraud')).toBe(true);
    expect(outcomeToBoolean('closed_no_fraud')).toBe(false);
    expect(outcomeToBoolean('inconclusive')).toBe(null);
  });
});

describe('case pack labels', () => {
  const pack = findCasePack();

  it('locates the supplied pack', () => {
    expect(pack).not.toBe(null);
    expect(fs.existsSync(pack as string)).toBe(true);
  });

  const rows = pack ? loadCasePack(pack) : [];

  it('parses usable rows with amount-from-trigger-text', () => {
    expect(rows.length).toBeGreaterThan(0);
    const hhg1 = rows.find((r) => r.case_id === 'HHG-001');
    expect(hhg1).toBeDefined();
    expect(hhg1!.card_id).toBe('C12382-K1');
    expect(hhg1!.transaction_id).toBe('3514030');
    expect(hhg1!.amount_usd).toBeCloseTo(77.07, 2);
    expect(hhg1!.risk_score).toBeCloseTo(0.61, 2);
    expect(hhg1!.trigger_type).toBe('risk_score');
    expect(hhg1!.opened_at).toBe('2016-12-05 01:55:28');
    // The answer key is withheld from the pack: no row may carry a usable outcome.
    expect(hhg1!.expected_fraud).toBe(null);
  });

  it('indexes labels by card id', () => {
    const idx = labelIndex(rows);
    expect(idx.get('C12382-K1')).toBeDefined();
    expect(idx.get('C12382-K1')!.expected_fraud).toBe(null);
  });
});

describe('closed-case labels (the honest label source)', () => {
  it('loads outcomes and patterns from closed_cases_history.csv', () => {
    const file = path.join(process.cwd(), 'data', 'raw', 'HHGOA_IEEE', 'closed_cases_history.csv');
    expect(fs.existsSync(file)).toBe(true);
    const labels = loadClosedCaseLabels(file);
    expect(labels.size).toBeGreaterThan(0);
    const first = labels.get('C00259-K1');
    expect(first).toBeDefined();
    expect(first!.expected_fraud).toBe(true);
    expect(first!.expected_pattern).toBe('card_not_present_fraud');
  });
});

describe('triggerFor', () => {
  const pack = findCasePack();
  const rows = pack ? loadCasePack(pack) : [];

  it('uses the pack’s own timestamp and trigger type', () => {
    const row = rows.find((r) => r.trigger_type === 'customer_report');
    expect(row).toBeDefined();
    const t = triggerFor(row!);
    expect(t.type).toBe('customer_report');
    expect(t.ts).toBe(row!.opened_at);
    expect(t.card_id).toBe(row!.card_id);
    expect(t.description).toContain(row!.transaction_id);
    if (row!.case_id) expect(t.description).toContain(row!.case_id);
  });

  it('maps risk_score triggers', () => {
    const row = rows.find((r) => r.trigger_type === 'risk_score');
    expect(row).toBeDefined();
    expect(triggerFor(row!).type).toBe('risk_score');
  });

  it('maps analyst_request triggers', () => {
    const row = rows.find((r) => r.trigger_type === 'analyst_request');
    expect(row).toBeDefined();
    expect(triggerFor(row!).type).toBe('analyst');
  });
});
