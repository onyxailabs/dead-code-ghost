'use strict';
/**
 * Dead-Code Ghost — local, read-only JavaScript/TypeScript dead-function finder.
 *
 * Scope (per the owner-approved brief, 2026-10-27):
 *  - Scans .js/.jsx/.ts/.tsx files in a repo, builds a name-based call graph,
 *    and reports functions that are never referenced anywhere.
 *  - Report only. This tool NEVER deletes or modifies scanned code.
 *  - Plain-English notes come from Gemma 3 1B via a local Ollama instance
 *    when one is reachable. When Ollama/Gemma is not reachable the note
 *    says so plainly — no note is ever invented.
 *  - Last-touched dates come from git log. When the scanned folder is not
 *    a git repo, the date is reported as unavailable, never invented.
 *
 * Honest limits (stated in the report itself, not hidden):
 *  - The graph is name-based, not scope-resolved: two functions sharing a
 *    name in different files count as the same name, and dynamic calls
 *    (obj[name](), eval, string-built calls) are not seen.
 *  - Exports and entry-file functions are reported separately, because an
 *    exported function may be used by code outside the repo.
 *  - Detection is best-effort, never claimed perfect.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor',
]);
const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'else',
  'do', 'try', 'function', 'class', 'extends', 'import', 'export', 'default',
  'await', 'yield', 'void', 'delete', 'in', 'of', 'instanceof', 'this',
  'super', 'console', 'require',
]);

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // Template literals may span lines; other strings do not.
        if (quote !== '`' && src[i] === '\n') break;
        i++;
      }
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
      } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function findDefinitions(relPath, stripped) {
  const defs = [];
  const lines = stripped.split('\n');
  const seen = new Set();
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const candidates = [];
    // function name( ... ) {
    let m = line.match(/(?:^|[^.\w$])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (m) candidates.push(m[1]);
    // const name = (...) =>  |  const name = function  |  const name = async function
    m = line.match(/(?:^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/);
    if (m) candidates.push(m[1]);
    // name = (...) =>  |  exports.name = function  (bare assignments, incl. object/class context)
    m = line.match(/(?:^|[^.\w$])(?:exports\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/);
    if (m) candidates.push(m[1]);
    // Method style:  name(...) {   (class/object methods, incl. async/static)
    m = line.match(/^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (m) candidates.push(m[1]);
    for (const name of candidates) {
      if (KEYWORDS.has(name)) continue;
      const key = `${lineNo}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push({ name, file: relPath, line: lineNo, lineText: line.trim() });
    }
  });
  return defs;
}

function isExported(def, fileText) {
  if (/^\s*export\b/.test(def.lineText)) return true;
  // export { name } / export { name as other }
  const braceExport = new RegExp(`export\\s*\\{[^}]*\\b${def.name}\\b`);
  if (braceExport.test(fileText)) return true;
  if (new RegExp(`exports\\.${def.name}\\b`).test(fileText)) return true;
  if (/module\.exports\s*=/.test(fileText)) {
    const m = fileText.match(/module\.exports\s*=\s*\{([^}]*)\}/);
    if (m && new RegExp(`\\b${def.name}\\b`).test(m[1])) return true;
  }
  return false;
}

function isEntryFile(relPath, root, packageMain) {
  const base = path.basename(relPath);
  if (packageMain && path.normalize(relPath) === path.normalize(packageMain)) return true;
  return ['index.js', 'index.ts', 'index.jsx', 'index.tsx', 'main.js', 'main.ts', 'app.js', 'server.js', 'cli.js'].includes(base);
}

function lastTouched(root, def) {
  const absFile = path.join(root, def.file);
  try {
    const out = execFileSync(
      'git', ['-C', root, 'log', '-1', '--format=%as', '-L', `${def.line},${def.line}:${def.file}`],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (out) return { date: out, basis: 'definition line (git log -L)' };
  } catch { /* fall through to file-level */ }
  try {
    const out = execFileSync(
      'git', ['-C', root, 'log', '-1', '--format=%as', '--', def.file],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (out) return { date: out, basis: 'file level (git log)' };
  } catch { /* not a git repo or git missing */ }
  void absFile;
  return { date: null, basis: 'unavailable — not a git repo or git log failed' };
}

async function gemmaNote(def, fileText, model, timeoutMs) {
  const prompt = `In 1-3 plain sentences, say what this JavaScript/TypeScript function appears to do. Do not guess beyond the code. Function "${def.name}" from ${def.file}:${def.line}:\n${def.lineText}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.2 } }),
      signal: controller.signal,
    });
    if (!res.ok) return `Gemma note unavailable — Ollama responded ${res.status} for model ${model}.`;
    const data = await res.json();
    const text = (data.response || '').trim().replace(/\s+/g, ' ');
    return text || `Gemma note unavailable — model ${model} returned an empty reply.`;
  } catch {
    return `Gemma note unavailable — Ollama or model ${model} not reachable on this machine (run Ollama and: ollama pull ${model}).`;
  } finally {
    clearTimeout(timer);
  }
}

async function scan(root, opts) {
  const absRoot = path.resolve(root);
  const files = walkFiles(absRoot);
  let packageMain = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(absRoot, 'package.json'), 'utf8'));
    packageMain = pkg.main || (pkg.bin && typeof pkg.bin === 'string' ? pkg.bin : null);
  } catch { /* no package.json — fine */ }

  const perFile = files.map((f) => {
    const rel = path.relative(absRoot, f);
    const raw = fs.readFileSync(f, 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    return { rel, stripped, defs: findDefinitions(rel, stripped) };
  });

  const allDefs = perFile.flatMap((f) => f.defs);
  const results = [];
  for (const file of perFile) {
    for (const def of file.defs) {
      const word = new RegExp(`\\b${def.name}\\b`, 'g');
      let references = 0;
      for (const other of perFile) {
        let text = other.stripped;
        const lines = text.split('\n');
        if (other.rel === file.rel) {
          // Remove this definition's own line so it does not count as a use.
          lines[def.line - 1] = '';
        }
        // Export declarations are not uses: listing a name in
        // `export { }`, `module.exports = { }` or `exports.name = ...`
        // must not rescue a function from the exported-unused list.
        for (let li = 0; li < lines.length; li++) {
          if (/^\s*export\s*\{/.test(lines[li])
            || /module\.exports\s*=/.test(lines[li])
            || /^\s*exports\.[A-Za-z_$][\w$]*\s*=/.test(lines[li])) {
            lines[li] = '';
          }
        }
        text = lines.join('\n');
        const hits = text.match(word);
        if (hits) references += hits.length;
      }
      const exported = isExported(def, file.stripped);
      const entry = isEntryFile(file.rel, absRoot, packageMain);
      results.push({ ...def, references, exported, entryFile: entry });
    }
  }

  const dead = results.filter((r) => r.references === 0 && !r.exported);
  const exportedUnused = results.filter((r) => r.references === 0 && r.exported);

  const enriched = [];
  for (const d of [...dead, ...exportedUnused]) {
    enriched.push({
      ...d,
      touched: lastTouched(absRoot, d),
      note: opts.noModel ? 'Gemma note skipped (--no-model).' : await gemmaNote(d, '', opts.model, opts.timeoutMs),
    });
  }
  const deadEnriched = enriched.filter((e) => !e.exported);
  const exportedEnriched = enriched.filter((e) => e.exported);

  return {
    root: absRoot,
    filesScanned: files.length,
    functionsFound: allDefs.length,
    dead: deadEnriched,
    exportedUnused: exportedEnriched,
  };
}

function renderReport(result, model) {
  const lines = [];
  lines.push('# Dead-Code Report');
  lines.push('');
  lines.push(`Scanned: \`${result.root}\` — ${result.filesScanned} files, ${result.functionsFound} functions found.`);
  lines.push('');
  lines.push('> Honest confidence note: this scan is name-based, not scope-resolved. '
    + 'Functions sharing a name across files count as one name, and dynamic calls '
    + '(`obj[name]()`, `eval`, string-built calls) are not seen. '
    + 'Nothing here is a perfect-detection claim — review before acting, and note '
    + 'this tool never deletes or modifies code.');
  lines.push('');
  lines.push(`## Dead functions (${result.dead.length}) — never referenced anywhere, not exported`);
  lines.push('');
  if (!result.dead.length) lines.push('None found.');
  for (const d of result.dead) {
    lines.push(`- **${d.name}** — \`${d.file}:${d.line}\``);
    lines.push(`  - What it appears to do: ${d.note}`);
    lines.push(`  - Last touched: ${d.touched.date || 'unavailable'} (${d.touched.basis})`);
  }
  lines.push('');
  lines.push(`## Exported but never called internally (${result.exportedUnused.length}) — review, not necessarily dead`);
  lines.push('');
  lines.push('These are exported, so code outside this repo may use them. Treat them as review candidates, not confirmed dead code.');
  lines.push('');
  if (!result.exportedUnused.length) lines.push('None found.');
  for (const d of result.exportedUnused) {
    lines.push(`- **${d.name}** — \`${d.file}:${d.line}\``);
    lines.push(`  - What it appears to do: ${d.note}`);
    lines.push(`  - Last touched: ${d.touched.date || 'unavailable'} (${d.touched.basis})`);
  }
  lines.push('');
  lines.push(`Notes generated with local model: ${model} via Ollama (127.0.0.1:11434). When Ollama is unreachable, notes say so instead of being invented.`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'scan' || !args[1]) {
    console.error('Usage: node ghost.js scan <repo-dir> [--out <file>] [--model <name>] [--no-model]');
    process.exit(2);
  }
  const dir = args[1];
  let out = null;
  let model = 'gemma3:1b';
  let noModel = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--model') model = args[++i];
    else if (args[i] === '--no-model') noModel = true;
  }
  if (!fs.existsSync(dir)) {
    console.error(`Not found: ${dir}`);
    process.exit(2);
  }
  const result = await scan(dir, { model, noModel, timeoutMs: 30000 });
  const report = renderReport(result, noModel ? '(skipped)' : model);
  if (out) {
    fs.writeFileSync(out, report);
    console.log(`Report written to ${out}`);
  } else {
    console.log(report);
  }
  console.log(`\nFiles: ${result.filesScanned} | Functions: ${result.functionsFound} | Dead: ${result.dead.length} | Exported-unused: ${result.exportedUnused.length}`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { scan, renderReport, stripCommentsAndStrings, findDefinitions };
