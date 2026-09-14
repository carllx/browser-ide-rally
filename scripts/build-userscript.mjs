/**
 * Userscript 轻量打包构建脚本
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1. 读取 Version SSOT (package.json)
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version || '0.3.0';

// 2. 生成标准的 Userscript Metadata Header
const metadataHeader = `// ==UserScript==
// @name         ChatGPT Runtime Event Detector (Rally Prototype)
// @namespace    https://github.com/carllx/browser-ide-rally
// @version      ${version}
// @description  ChatGPT Web 运行时双探测器生命周期感知原型 (Phase 3)
// @author       Rally Team
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/carllx/browser-ide-rally/main/dist/chatgpt-runtime-detector.user.js
// @downloadURL  https://raw.githubusercontent.com/carllx/browser-ide-rally/main/dist/chatgpt-runtime-detector.user.js
// ==/UserScript==
`;

// 3. 执行打包
async function build() {
  const entryFile = path.join(rootDir, 'src/tampermonkey/main.js');
  const distDir = path.join(rootDir, 'dist');
  const outFile = path.join(distDir, 'chatgpt-runtime-detector.user.js');

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const result = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    define: {
      '__RALLY_VERSION__': JSON.stringify(version)
    }
  });

  const bundledCode = result.outputFiles[0].text;
  const finalBundle = `${metadataHeader}\n${bundledCode}`;

  fs.writeFileSync(outFile, finalBundle, 'utf8');

  console.log(`[Build] Successfully built Tampermonkey Userscript bundle:`);
  console.log(`  - Target: ${path.relative(rootDir, outFile)}`);
  console.log(`  - Version SSOT: ${version}`);
  console.log(`  - Size: ${(finalBundle.length / 1024).toFixed(2)} KB`);
}

build().catch((err) => {
  console.error('[Build Failed]', err);
  process.exit(1);
});
