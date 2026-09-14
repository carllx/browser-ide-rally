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

const testFiles = [
  path.join(rootDir, 'tests/build-verification.test.js'),
  path.join(rootDir, 'tests/unit/classifier.test.js'),
  path.join(rootDir, 'tests/unit/generation-store.test.js'),
  path.join(rootDir, 'tests/unit/dom-detector.test.js'),
  path.join(rootDir, 'tests/unit/resolver.test.js')
];

const testStream = run({ files: testFiles });
testStream.compose(spec).pipe(process.stdout);

testStream.on('test:fail', () => {
  process.exitCode = 1;
});
