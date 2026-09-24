/** @module core — Evidence helpers for candidate generation */

import { InvestigationState } from './types.js';

/**
 * Dig a device id out of any evidence payload we may have gathered: top-level
 * (`device_neighbors`), nested under `txn` (`txn_detail`), a `kind/value` pair
 * (`sharedElementCards`) or the `devices` list (`graph_context`).
 */
export function findDeviceInEvidence(state: InvestigationState): string | null {
  for (const e of state.evidence) {
    const data = e.data as any;
    if (!data) continue;
    if (data.device_id) return data.device_id;
    if (data.device_profile) return data.device_profile;
    if (data.txn?.device_id) return data.txn.device_id;
    if (data.kind === 'device' && data.value) return data.value;
    if (Array.isArray(data.devices) && data.devices.length && data.devices[0]) return data.devices[0];
  }
  return null;
}

/** Same treatment for billing regions (`txn_detail.txn.region`, `kind/value`, `regions[]`). */
export function findRegionInEvidence(state: InvestigationState): string | null {
  for (const e of state.evidence) {
    const data = e.data as any;
    if (!data) continue;
    if (data.region) return data.region;
    if (data.txn?.region) return data.txn.region;
    if (data.kind === 'region' && data.value) return data.value;
    if (Array.isArray(data.regions) && data.regions.length && data.regions[0]) return data.regions[0];
  }
  return null;
}

/** Recipient email domain, likewise (`txn_detail.txn.email_domain`, `kind/value`, `email_domains[]`). */
export function findEmailInEvidence(state: InvestigationState): string | null {
  for (const e of state.evidence) {
    const data = e.data as any;
    if (!data) continue;
    if (data.email_domain) return data.email_domain;
    if (data.recipient_email_domain) return data.recipient_email_domain;
    if (data.txn?.email_domain) return data.txn.email_domain;
    if (data.kind === 'email' && data.value) return data.value;
    if (Array.isArray(data.email_domains) && data.email_domains.length && data.email_domains[0]) return data.email_domains[0];
  }
  return null;
}

/** Tools that already produced evidence (evidence refs are `query:<tool>`). */
export function triedTools(state: InvestigationState): Set<string> {
  const out = new Set<string>();
  for (const e of state.evidence) {
    if (!e.ref?.startsWith('query:')) continue;
    for (const t of e.ref.slice('query:'.length).split(',')) if (t) out.add(t.trim());
  }
  return out;
}

/** The flagged transaction as returned by `txn_detail`, when that evidence exists. */
export function findFlaggedTxn(state: InvestigationState): Record<string, any> | null {
  for (const e of state.evidence) {
    const d = e.data as any;
    if (e.ref?.includes('txn_detail') && d?.txn) return d.txn;
  }
  return null;
}

/**
 * Every transaction view gathered so far, deduped by txn id. Includes the txns inside
 * card-testing sequences. Note payloads from `device_neighbors` / `region_cluster`
 * carry *other* cards' txns — callers that reason about the flagged card's own history
 * must filter on `card_id`.
 */
export function findSeenTxns(state: InvestigationState): Record<string, any>[] {
  const byId = new Map<string, Record<string, any>>();
  const add = (t: any) => {
    if (t && t.txn_id !== undefined && !byId.has(String(t.txn_id))) byId.set(String(t.txn_id), t);
  };
  for (const e of state.evidence) {
    const d = e.data as any;
    if (!d) continue;
    if (d.txn) add(d.txn);
    if (Array.isArray(d.txns)) for (const t of d.txns) add(t);
    if (Array.isArray(d.sequences)) {
      for (const s of d.sequences) {
        for (const t of s?.small_txns ?? []) add(t);
        if (s?.follow_up) add(s.follow_up);
      }
    }
  }
  return [...byId.values()];
}

/** Parse dataset timestamps (`YYYY-MM-DD HH:MM:SS` or ISO, with or without Z). */
export function parseTimestamp(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const s = String(ts);
  const ms = Date.parse(/[zZ]$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Features for precedent retrieval. Seeded from the trigger (always available), then
 * overlaid with the first entity facts any evidence produced.
 */
export function extractSimilarCaseFeatures(state: InvestigationState): Record<string, unknown> {
  const features: Record<string, unknown> = {
    card_id: state.trigger.card_id,
    customer_id: state.trigger.customer_id,
    amount_usd: state.trigger.amount_usd,
    ts: state.trigger.ts,
    trigger_type: state.trigger.type,
  };
  if (state.assessed_pattern) features.pattern_hint = state.assessed_pattern;
  for (const e of state.evidence) {
    const d = e.data as any;
    if (!d) continue;
    const txn = d.txn ?? null;
    if (txn?.device_id && !features.device_ids) features.device_ids = [txn.device_id];
    if (txn?.region && !features.region) features.region = txn.region;
    if (txn?.email_domain && !features.email_domain) features.email_domain = txn.email_domain;
  }
  return features;
}
