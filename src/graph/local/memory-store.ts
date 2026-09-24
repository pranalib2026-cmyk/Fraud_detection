/**
 * Local persistence for investigation records.
 *
 * When a TigerGraph deployment is reachable these same records are written to the
 * graph (`write_case`, `write_evidence`, `write_audit` -> GSQL upserts via MCP). This
 * store keeps the offline/degraded mode functional and always provides the audit
 * trail, and it is *labelled* as local so nothing claims graph persistence that did
 * not happen.
 */
import fs from 'node:fs';
import path from 'node:path';

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });

export class LocalMemoryStore {
  dir: string;
  casesDir: string;
  evidenceDir: string;
  auditDir: string;

  constructor(dir) {
    this.dir = dir;
    this.casesDir = path.join(dir, 'cases');
    this.evidenceDir = path.join(dir, 'evidence');
    this.auditDir = path.join(dir, 'audit');
    ensure(this.casesDir);
    ensure(this.evidenceDir);
    ensure(this.auditDir);
  }

  saveCase(record) {
    const file = path.join(this.casesDir, `${record.case_id}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
    return { stored_at: new Date().toISOString(), file };
  }

  updateCase(caseId, patch) {
    const existing = this.getCase(caseId) ?? { case_id: caseId, created_at: new Date().toISOString() };
    const merged = { ...existing, ...patch, updated_at: new Date().toISOString() };
    fs.writeFileSync(path.join(this.casesDir, `${caseId}.json`), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  getCase(caseId) {
    const file = path.join(this.casesDir, `${caseId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  listCases() {
    return fs.readdirSync(this.casesDir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.casesDir, f), 'utf8')));
  }

  appendEvidence(caseId, items) {
    const file = path.join(this.evidenceDir, `${caseId}.jsonl`);
    const lines = items.map((i) => JSON.stringify(i)).join('\n');
    fs.appendFileSync(file, `${lines}\n`, 'utf8');
    return items.length;
  }

  readEvidence(caseId) {
    const file = path.join(this.evidenceDir, `${caseId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  appendAudit(events) {
    const list = Array.isArray(events) ? events : [events];
    const byCase = new Map();
    for (const e of list) {
      const key = e.case_id ?? 'system';
      const arr = byCase.get(key) ?? [];
      arr.push(e);
      byCase.set(key, arr);
    }
    for (const [caseId, arr] of byCase) {
      const file = path.join(this.auditDir, `${caseId}.jsonl`);
      fs.appendFileSync(file, `${arr.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    }
    return list.length;
  }

  readAudit(caseId) {
    const file = path.join(this.auditDir, `${caseId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  stats() {
    return {
      dir: this.dir,
      cases: fs.readdirSync(this.casesDir).length,
      evidence_files: fs.readdirSync(this.evidenceDir).length,
      audit_files: fs.readdirSync(this.auditDir).length,
    };
  }
}
