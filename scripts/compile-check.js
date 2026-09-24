import { parseJsonConfigFileContent, createProgram, sys, flattenDiagnosticMessageText } from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const p = path.resolve('tsconfig.json');
const raw = fs.readFileSync(p, 'utf8');
const parsed = JSON.parse(raw);
const cfg = parseJsonConfigFileContent(parsed, sys, path.dirname(p));

for (const e of cfg.errors) {
  console.log('CONFIG-ERROR:', flattenDiagnosticMessageText(e.messageText, ' '));
}
if (cfg.errors.length) process.exit(1);

// NOTE: pass `cfg.options` (CompilerOptions), not `cfg` — passing the ParsedCommandLine
// silently discards every compiler option.
const prog = createProgram(cfg.fileNames, cfg.options);
// Syntactic + semantic: a syntax error alone can still type-check "clean" if only
// semantic diagnostics are queried (esbuild/vitest would then fail at transform time).
const syn = prog.getSyntacticDiagnostics();
const sem = prog.getSemanticDiagnostics();
const diags = [...syn, ...sem];

console.log('Config:', cfg.configFile?.fileName ?? p);
console.log('Target:', String(cfg.options.target), '· Module:', String(cfg.options.module), '· Files:', cfg.fileNames.length);
console.log('Syntactic errors:', syn.length, '· Semantic errors:', sem.length);

if (diags.length > 0) {
  const byFile = new Map();
  for (const d of diags) {
    const f = d.file?.fileName ?? '?';
    const key = path.relative(process.cwd(), f).replace(/\\/g, '/');
    const list = byFile.get(key) ?? [];
    list.push(flattenDiagnosticMessageText(d.messageText, ' '));
    byFile.set(key, list);
  }
  for (const [file, messages] of [...byFile.entries()].sort()) {
    console.log(`\n${file} (${messages.length})`);
    for (const m of messages.slice(0, 12)) console.log(`  - ${m}`);
  }
  process.exit(1);
}

console.log('TypeScript clean.');
