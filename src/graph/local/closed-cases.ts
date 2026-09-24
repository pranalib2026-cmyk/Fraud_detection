/**
 * Closed-case history: the labelled memory of the bank (July-October).
 *
 * Used for two different jobs, kept strictly apart:
 *   1. Aggregate base rates (e.g. share of closed cases with pattern X that were
 *      confirmed fraud). Statistics over labelled data, never a lookup of an
 *      individual case's answer.
 *   2. Precedent retrieval: structurally/contextually similar prior cases, returned
 *      with the reasons they matched so an analyst can judge them. Precedent is
 *      never copied into a verdict.
 */
import path from 'node:path';
import { readCsvFile, num } from '../../dataset/csv.js';

export function loadClosedCases(rawDir, projection) {
  const rows = readCsvFile(path.join(rawDir, 'closed_cases_history.csv'));
  const byTxn = new Map();
  const cases = rows.map((r) => {
    const txnIds = String(r.txn_ids || '').split('|').map((t) => t.trim()).filter(Boolean);
    const devices = new Set();
    const regions = new Set();
    const emails = new Set();
    const channels = new Set();
    const cards = new Set([r.card_id].filter(Boolean));
    let riskSum = 0;
    let riskCount = 0;
    for (const t of txnIds) {
      const row = projection.rowOf(t);
      if (row < 0) continue;
      const d = projection.deviceIdx(row);
      if (d >= 0) devices.add(projection.device(d).device_id);
      regions.add(projection.region(projection.regionIdx(row)));
      emails.add(projection.email(projection.emailIdx(row)));
      channels.add(projection.channelIdx(row) === 1 ? 'online' : 'in_person');
      const risk = projection.riskIdx(row);
      if (risk !== 255) { riskSum += risk / 100; riskCount++; }
      byTxn.set(String(projection.txnId(row)), r.case_id);
    }
    return {
      case_id: r.case_id,
      customer_id: r.customer_id,
      card_id: r.card_id,
      opened_at: r.opened_at,
      closed_at: r.closed_at,
      outcome: r.outcome,
      pattern: r.pattern,
      first_fraud_txn_id: r.first_fraud_txn_id ?? '',
      txn_ids: txnIds,
      n_txns: num(r.n_txns, txnIds.length),
      exposure_usd: num(r.exposure_usd, 0),
      connected_card_ids: String(r.connected_card_ids || '').split('|').map((c) => c.trim()).filter(Boolean),
      actions_taken: String(r.actions_taken || '').split('|').filter(Boolean),
      report_filed: r.report_filed === 'Yes',
      analyst_notes: r.analyst_notes ?? '',
      device_ids: [...devices],
      regions: [...regions].filter(Boolean),
      email_domains: [...emails].filter(Boolean),
      channels: [...channels],
      cards: [...cards],
      avg_risk_score: riskCount ? +(riskSum / riskCount).toFixed(3) : null,
    };
  });
  return { cases, byTxn };
}

/** Aggregate labelled statistics - the only place historical outcomes inform reasoning. */
export function closedCaseStatistics(closedCases) {
  const byPattern = new Map();
  for (const c of closedCases) {
    const bucket = byPattern.get(c.pattern) ?? {
      pattern: c.pattern, total: 0, confirmed_fraud: 0, cleared: 0,
      exposure_sum: 0, multi_txn: 0, report_filed: 0, connected: 0,
    };
    bucket.total++;
    if (c.outcome === 'confirmed_fraud') bucket.confirmed_fraud++;
    else bucket.cleared++;
    bucket.exposure_sum += c.exposure_usd;
    if (c.n_txns > 1) bucket.multi_txn++;
    if (c.report_filed) bucket.report_filed++;
    if (c.connected_card_ids.length) bucket.connected++;
    byPattern.set(c.pattern, bucket);
  }
  const patterns = [...byPattern.values()].map((b) => ({
    ...b,
    confirmed_fraud_rate: +(b.confirmed_fraud / b.total).toFixed(3),
    mean_exposure_usd: +(b.exposure_sum / b.total).toFixed(2),
  }));
  const fraudCount = closedCases.filter((c) => c.outcome === 'confirmed_fraud').length;
  return {
    overall: {
      total: closedCases.length,
      confirmed_fraud: fraudCount,
      cleared: closedCases.filter((c) => c.outcome === 'cleared').length,
      report_filed: closedCases.filter((c) => c.report_filed).length,
      report_filed_rate_among_fraud: +(closedCases.filter((c) => c.report_filed).length / Math.max(1, fraudCount)).toFixed(3),
      confirmed_fraud_rate: +(fraudCount / closedCases.length).toFixed(3),
    },
    by_pattern: patterns,
  };
}

/**
 * Precedent retrieval. Features come from the live case; the reasons for each match
 * are returned so the UI and the case file can show why a precedent is relevant.
 */
export function findSimilarCases(closedCases, features, k = 5) {
  const {
    card_id = '', customer_id = '', device_ids = [], region = '', email_domain = '',
    pattern_hint = '', amount_usd = 0, ts = '', trigger_type = '',
  } = features ?? {};
  const anchorMs = ts ? Date.parse(`${ts.replace(' ', 'T')}Z`) : null;
  const windowDays = 60;

  const scored = [];
  for (const c of closedCases) {
    let score = 0;
    const reasons = [];
    if (card_id && c.card_id === card_id) { score += 5; reasons.push(`same card ${card_id}`); }
    if (customer_id && c.customer_id === customer_id) { score += 3; reasons.push(`same customer ${customer_id}`); }
    const sharedDevices = c.device_ids.filter((d) => device_ids.includes(d));
    if (sharedDevices.length) { score += 4 * sharedDevices.length; reasons.push(`shared device profile (${sharedDevices.length})`); }
    if (region && c.regions.includes(region)) { score += 1; reasons.push(`same billing region ${region}`); }
    if (email_domain && c.email_domains.includes(email_domain)) { score += 1; reasons.push(`same purchaser email domain ${email_domain}`); }
    if (pattern_hint && c.pattern === pattern_hint) { score += 2; reasons.push(`same documented pattern ${pattern_hint}`); }
    if (trigger_type === 'risk_score' && c.pattern === 'none') { score += 0.5; reasons.push('cleared alert of the same trigger type'); }
    if (amount_usd && c.exposure_usd) {
      const ratio = Math.min(amount_usd, c.exposure_usd) / Math.max(amount_usd, c.exposure_usd);
      if (ratio > 0.5) { score += 1; reasons.push(`comparable exposure ($${c.exposure_usd})`); }
    }
    if (anchorMs !== null) {
      const cMs = Date.parse(`${c.closed_at.replace(' ', 'T')}Z`);
      const days = Math.abs(cMs - anchorMs) / 86_400_000;
      if (days <= windowDays) { score += 0.5; reasons.push(`closed within ${Math.round(days)} days of the trigger`); }
    }
    if (score <= 0) continue;
    scored.push({
      case_id: c.case_id,
      score: +score.toFixed(2),
      matched_on: reasons,
      outcome: c.outcome,
      pattern: c.pattern,
      exposure_usd: c.exposure_usd,
      cards: c.cards,
      connected_card_ids: c.connected_card_ids,
      device_ids: c.device_ids,
      actions_taken: c.actions_taken,
      report_filed: c.report_filed,
      closed_at: c.closed_at,
      notes_excerpt: c.analyst_notes.slice(0, 320),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

