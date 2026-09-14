import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('Build Verification: generated bundle exists and is valid', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const bundlePath = path.join(rootDir, 'dist/chatgpt-runtime-detector.user.js');

  assert.ok(fs.existsSync(bundlePath), 'dist/chatgpt-runtime-detector.user.js must exist');

  const content = fs.readFileSync(bundlePath, 'utf8');

  // 1. Metadata header is first content
  assert.ok(content.startsWith('// ==UserScript=='), 'Must start with // ==UserScript==');

  // 2. @version matches canonical package.json version
  const versionMatch = content.match(/\/\/ @version\s+([^\s]+)/);
  assert.ok(versionMatch, 'Must contain @version');
  assert.equal(versionMatch[1], pkg.version, `@version must match package.json (${pkg.version})`);

  // 3. @updateURL and @downloadURL valid
  const updateMatch = content.match(/\/\/ @updateURL\s+([^\s]+)/);
  const downloadMatch = content.match(/\/\/ @downloadURL\s+([^\s]+)/);
  assert.ok(updateMatch, 'Must contain @updateURL');
  assert.ok(downloadMatch, 'Must contain @downloadURL');
  assert.equal(updateMatch[1], 'https://raw.githubusercontent.com/carllx/browser-ide-rally/main/dist/chatgpt-runtime-detector.user.js');
  assert.equal(downloadMatch[1], 'https://raw.githubusercontent.com/carllx/browser-ide-rally/main/dist/chatgpt-runtime-detector.user.js');

  // 4. No source map secrets or leak
  assert.ok(!content.includes('sourceMappingURL='), 'Should not contain raw source map secrets');

  // 5. JavaScript syntax parses cleanly
  assert.doesNotThrow(() => {
    new Function(content);
  }, 'Bundle content must be valid JavaScript syntax');
});

test('Size rule: all handwritten source modules are under 600 lines', () => {
  const srcDir = path.join(rootDir, 'src/tampermonkey');
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));

  for (const f of files) {
    const filePath = path.join(srcDir, f);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').length;
    assert.ok(
      lines < 600,
      `Handwritten file ${f} has ${lines} lines, exceeding the 600-line hard ceiling!`
    );
  }
});
