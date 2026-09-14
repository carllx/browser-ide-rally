/**
 * 统一测试套件执行器
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function findTestFiles(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findTestFiles(fullPath));
    } else if (entry.name.endsWith('.test.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

const testFiles = findTestFiles(path.join(rootDir, 'tests'));

const testStream = run({ files: testFiles });
testStream.compose(spec).pipe(process.stdout);

testStream.on('test:fail', () => {
  process.exitCode = 1;
});

