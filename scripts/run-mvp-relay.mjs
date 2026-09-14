#!/usr/bin/env node
/**
 * Rally MVP Relay 运行时入口
 * 使用仓库自有模块驱动端到端 Browser → IDE → Browser 轮转
 */

import { parseArgs } from 'node:util';
import { createBinding } from '../src/controller/binding.js';
import { RallyController } from '../src/controller/controller.js';
import { ChatGPTChromeAdapter } from '../src/adapters/browser/chatgpt-chrome.js';
import { AntigravityAdapter } from '../src/adapters/ide/antigravity.js';

const { values } = parseArgs({
  options: {
    'browser-conv': { type: 'string' },
    'ide-conv': { type: 'string' },
    'workspace': { type: 'string' },
    'repo': { type: 'string' },
    'prompt-browser': { type: 'boolean', default: false },
    'timeout': { type: 'string', default: '60000' }
  },
  allowPositionals: true
});

const browserConvId = values['browser-conv'];
const ideConvId = values['ide-conv'];
const workspaceUri = values['workspace'] || 'file:///Users/yamlam/Documents/GitHub/browser-ide-rally';
const repoIdentity = values['repo'] || 'carllx/browser-ide-rally';
const promptBrowser = values['prompt-browser'] ?? true;
const timeoutMs = parseInt(values['timeout'], 10) || 60000;

if (!browserConvId || !ideConvId) {
  console.error('Usage: node scripts/run-mvp-relay.mjs --browser-conv=<id> --ide-conv=<id> [--workspace=<uri>] [--repo=<name>] [--prompt-browser]');
  process.exit(1);
}

console.log('================================================================');
console.log('=== RALLY MVP RELAY: REPOSITORY-OWNED RUNTIME EXECUTION ===');
console.log('================================================================');
console.log(`[Config] Browser Conversation: ${browserConvId}`);
console.log(`[Config] Target IDE Conversation: ${ideConvId}`);
console.log(`[Config] Workspace Identity:    ${workspaceUri}`);
console.log(`[Config] Repository Identity:   ${repoIdentity}`);
console.log(`[Config] Prompt Browser Agent:  ${promptBrowser}`);
console.log(`[Config] Timeout:               ${timeoutMs}ms`);

// 1. 初始化 Binding 记录
const binding = createBinding({
  binding_id: `bind-${Date.now()}`,
  binding_revision: 1,
  browser: {
    provider: 'chatgpt',
    conversation_id: browserConvId
  },
  ide: {
    conversation_id: ideConvId,
    workspace_identity: workspaceUri,
    repository_identity: repoIdentity
  }
});

// 2. 初始化 Adapters
const browserAdapter = new ChatGPTChromeAdapter();
const ideAdapter = new AntigravityAdapter();

// 3. 初始化 Controller
const controller = new RallyController({
  binding,
  browserAdapter,
  ideAdapter
});

console.log('\n>>> Starting autonomous round-trip execution...');

try {
  const result = await controller.executeRoundTrip({
    promptBrowser,
    timeoutMs
  });

  console.log('\n================================================================');
  console.log('=== EXECUTION FINISHED ===');
  console.log('================================================================');
  console.log(`Success: ${result.success}`);
  if (result.error) {
    console.error(`Error:   ${result.error}`);
  }

  console.log('\n--- COMPACT STATUS VIEW ---');
  console.log(result.compactStatus);

  console.log('\n--- MACHINE-READABLE STATUS DUMP ---');
  console.log(JSON.stringify(result.statusDump, null, 2));

  if (result.success) {
    console.log('\n--- VERIFIED RUNTIME ARTIFACTS ---');
    console.log('Captured Envelope:', JSON.stringify(result.capturedEnvelope, null, 2));
    console.log('IDE Result:', JSON.stringify(result.ideResult, null, 2));
    console.log('Browser ACK:', result.browserAck);
  }

  process.exit(result.success ? 0 : 1);
} catch (e) {
  console.error('\nFATAL RELAY EXCEPTION:', e.message);
  process.exit(1);
}
