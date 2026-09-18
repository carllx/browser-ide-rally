import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatGPTBrowserAdapter } from '../../src/adapters/browser/chatgpt-browser-adapter.js';
import { AntigravityIdeAdapter } from '../../src/adapters/ide/antigravity-adapter.js';
import { createProjectStatusCore } from '../../src/status/status-core.js';
import { createBinding } from '../../src/controller/binding.js';

test('Adapter Result Capture — 1. Browser 适配器捕获完成文本并生成 product-safe result_ref', () => {
  const rawMessageId = 'msg-raw-uuid-123456';
  const messageText = 'Here is the completed browser turn solution code.';

  const mockExecutor = (script) => {
    if (script.includes('set matchCount to 0')) {
      return 'SUCCESS:1:1:https://chatgpt.com/c/conv-br-test';
    }
    return JSON.stringify({
      isGenerating: false,
      assistantCount: 1,
      lastMessageId: rawMessageId,
      lastMessageText: messageText,
      hasValidLastMessage: true,
      isPlaceholder: false
    });
  };

  const adapter = new ChatGPTBrowserAdapter({ executor: mockExecutor });
  const obs = adapter.observeBrowserEndpoint({
    conversationId: 'conv-br-test',
    bindingRevision: 1
  });

  assert.strictEqual(obs.trusted, true);
  assert.strictEqual(obs.latest_completed_cursor, `chatgpt_msg_${rawMessageId}`);
  assert.ok(obs.latest_completed_result, 'should have latest_completed_result');

  const res = obs.latest_completed_result;
  assert.strictEqual(res.cursor, `chatgpt_msg_${rawMessageId}`);
  assert.strictEqual(res.text, messageText);
  assert.ok(typeof res.result_ref === 'string');
  assert.match(res.result_ref, /^res_[a-f0-9]{12,32}$/);

  // 严格断言：禁止在 result_ref 中泄露 raw message id
  assert.strictEqual(res.result_ref.includes(rawMessageId), false);
});

test('Adapter Result Capture — 2. Antigravity 适配器捕获完成文本并生成 product-safe result_ref', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-res-test-'));
  const convId = 'conv-ag-res-1';
  const convDir = path.join(tmpDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(convDir, { recursive: true });
  const transcriptPath = path.join(convDir, 'transcript.jsonl');

  const stepContent = 'Task completed: all 5 unit tests passing.';
  const transcriptLines = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'Run test' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: stepContent,
      tool_calls: [],
      created_at: '2026-09-18T10:00:00Z'
    })
  ].join('\n');
  fs.writeFileSync(transcriptPath, transcriptLines, 'utf8');

  const binding = createBinding({
    binding_id: 'proj-ag-res',
    browser: { provider: 'chatgpt', conversation_id: 'conv-br' },
    ide: {
      conversation_id: convId,
      workspace_identity: tmpDir,
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  const core = createProjectStatusCore({ binding });
  const adapter = new AntigravityIdeAdapter({ binding, statusCore: core });

  // 模拟 stop hook
  // 使用 real git remote 匹配
  const res = adapter.handleStopHook({
    conversationId: convId,
    workspacePaths: [process.cwd()], // 当前项目工作区
    fullyIdle: true,
    terminationReason: 'NO_TOOL_CALL',
    transcriptPath
  });

  // workspacePaths 需要匹配 binding 的 workspace_identity
  // 让我们针对 workspace 配置重新构造 binding
  const bindingMatched = createBinding({
    binding_id: 'proj-ag-res-2',
    browser: { provider: 'chatgpt', conversation_id: 'conv-br' },
    ide: {
      conversation_id: convId,
      workspace_identity: process.cwd(),
      repository_identity: 'carllx/browser-ide-rally'
    }
  });
  const coreMatched = createProjectStatusCore({ binding: bindingMatched });
  const adapterMatched = new AntigravityIdeAdapter({ binding: bindingMatched, statusCore: coreMatched });

  const hookRes = adapterMatched.handleStopHook({
    conversationId: convId,
    workspacePaths: [process.cwd()],
    fullyIdle: true,
    terminationReason: 'NO_TOOL_CALL',
    transcriptPath
  });

  assert.strictEqual(hookRes.accepted, true);
  const snap = coreMatched.getSnapshot();
  const ideFact = snap.endpoints.ide;
  assert.strictEqual(ideFact.result_state, 'NEW');
  assert.ok(ideFact.latest_completed_result);

  const resultMat = ideFact.latest_completed_result;
  assert.strictEqual(resultMat.text, stepContent);
  assert.strictEqual(resultMat.cursor, ideFact.latest_completed_cursor);
  assert.match(resultMat.result_ref, /^res_[a-f0-9]{12,32}$/);

  // 严格断言：禁止在 result_ref 中泄露 step_index 或 step fingerprint
  assert.strictEqual(resultMat.result_ref.includes('ag-step'), false);
  assert.strictEqual(resultMat.result_ref.includes('step_index'), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
