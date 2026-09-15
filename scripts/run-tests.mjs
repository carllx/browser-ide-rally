/**
 * 统一测试套件执行器
 * 遍历 tests 目录下所有以 .test.js 结尾的文件并通过 node:test 运行
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
  if (!fs.existsSync(dir)) {
    return results;
  }
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

if (testFiles.length === 0) {
  console.log('未找到测试文件');
  process.exit(0);
}

const testStream = run({ files: testFiles });
testStream.compose(spec).pipe(process.stdout);

testStream.on('test:fail', () => {
  process.exitCode = 1;
});
