'use strict';
/**
 * Tests for Dead-Code Ghost.
 * - Scans the bundled sample repo (a real scan, not mocked results).
 * - Asserts the expected dead / exported-unused sets.
 * - Asserts the scanned sample files are byte-identical after the scan
 *   (the tool must never modify scanned code).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scan, renderReport } = require('../ghost');

async function main() {
  const sample = path.join(__dirname, '..', 'sample-repo');
  const sampleFiles = ['src/index.js', 'src/utils.js', 'src/helpers.ts'];
  const before = new Map(sampleFiles.map((f) => [
    f, crypto.createHash('sha256').update(fs.readFileSync(path.join(sample, f))).digest('hex'),
  ]));

  const result = await scan(sample, { model: 'gemma3:1b', noModel: true, timeoutMs: 5000 });
  const report = renderReport(result, '(skipped in tests)');

  const deadNames = result.dead.map((d) => d.name).sort();
  const exportedNames = result.exportedUnused.map((d) => d.name).sort();

  assert.deepStrictEqual(
    deadNames,
    ['deadTsHelper', 'idle', 'oldHelper', 'unusedCalc'],
    `dead set mismatch: ${deadNames.join(', ')}`,
  );
  assert.deepStrictEqual(
    exportedNames,
    ['formatDate', 'publicApi'],
    `exported-unused set mismatch: ${exportedNames.join(', ')}`,
  );
  // Used functions must NOT appear as dead.
  for (const used of ['add', 'greet', 'run']) {
    assert.ok(!deadNames.includes(used), `${used} wrongly reported dead`);
  }
  // Report must carry the honesty notes.
  assert.ok(report.includes('never deletes or modifies code'), 'report missing honesty note');
  assert.ok(report.includes('Dead functions'), 'report missing dead section');
  assert.ok(report.includes('Exported but never called internally'), 'report missing exported section');
  // Sample files untouched.
  for (const f of sampleFiles) {
    const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(sample, f))).digest('hex');
    assert.strictEqual(after, before.get(f), `sample file modified by scan: ${f}`);
  }
  console.log(`PASS: dead=[${deadNames.join(', ')}] exported-unused=[${exportedNames.join(', ')}] files=${result.filesScanned} functions=${result.functionsFound} sample-untouched=true`);
}

main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
