import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { projectStatusSurface } from '../../src/surface/surface-projection.js';
import { renderStatusSurfaceHtml } from '../../src/surface/surface-template.js';

test('Surface Integration — 1. POST /api/projects/:bindingId/controls/continue 成功派发与状态保留', async () => {
  const registry = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-http-continue',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br-http' },
    ide_endpoints: [{
      endpoint_id: 'ide-1',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-http',
      workspace_identity: '/ws',
      repository_identity: 'owner/repo'
    }]
  });
  const core = registry.registerProject({ binding });

  const dispatchedTasks = [];
  const ideAdapter = {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: ({ conversationId, envelope, targetEndpoint }) => {
      dispatchedTasks.push({ conversationId, envelope, targetEndpoint });
      return { delivery_proven: true, delivery_evidence: 'IDE prompt delivered' };
    }
  };

  const dispatchedPrompts = [];
  const browserAdapter = {
    checkComposerPreflight: () => ({ ready: true }),
    sendTextPrompt: (conversationId, text) => {
      dispatchedPrompts.push({ conversationId, text });
      return { delivery_proven: true, delivery_evidence: 'Browser prompt delivered' };
    }
  };

  // 设置两端均为 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-br-http',
    trusted: true,
    latest_completed_cursor: 'cur-br-http',
    latest_completed_result: {
      cursor: 'cur-br-http',
      result_ref: 'res_br_http',
      text: 'Browser plan content here.',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  core.recordEndpointObservation('ide-1', {
    conversation_id: 'conv-ide-http',
    workspace_identity: '/ws',
    repository_identity: 'owner/repo',
    endpoint_revision: 1,
    trusted: true,
    latest_completed_cursor: 'cur-ide-http',
    latest_completed_result: {
      cursor: 'cur-ide-http',
      result_ref: 'res_ide_http',
      text: 'IDE test code here.',
      captured_at: '2026-09-18T10:05:00Z'
    }
  });

  const { server, port, close } = await startStatusSurfaceServer({
    registry,
    browserAdapter,
    ideAdapters: ideAdapter
  });

  try {
    // 1) Continue in IDE
    const resIde = await fetch(`http://127.0.0.1:${port}/api/projects/proj-http-continue/controls/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        target_endpoint: 'ide-1',
        source_endpoint: 'browser',
        expected_source_result_state: 'NEW',
        expected_source_cursor: 'cur-br-http',
        expected_source_result_ref: 'res_br_http'
      })
    });

    assert.strictEqual(resIde.status, 200);
    const jsonIde = await resIde.json();
    assert.strictEqual(jsonIde.success, true);
    assert.strictEqual(jsonIde.stage, 'ACCEPTED_OR_DELIVERED');

    assert.strictEqual(dispatchedTasks.length, 1);
    assert.ok(dispatchedTasks[0].envelope.payload.text.includes('Browser plan content here.'));

    // 2) Continue in Browser (单 IDE 项目机械解析 source 为 ide-1)
    const resBr = await fetch(`http://127.0.0.1:${port}/api/projects/proj-http-continue/controls/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        target_endpoint: 'browser',
        expected_source_result_state: 'NEW',
        expected_source_cursor: 'cur-ide-http',
        expected_source_result_ref: 'res_ide_http'
      })
    });

    assert.strictEqual(resBr.status, 200);
    const jsonBr = await resBr.json();
    assert.strictEqual(jsonBr.success, true);

    assert.strictEqual(dispatchedPrompts.length, 1);
    assert.ok(dispatchedPrompts[0].text.includes('IDE test code here.'));

    // 验证快照依然保持独立的 NEW
    const snap = core.getSnapshot();
    assert.strictEqual(snap.endpoints.browser.result_state, 'NEW');
    assert.strictEqual(snap.endpoints.ide_endpoints['ide-1'].result_state, 'NEW');
  } finally {
    await close();
  }
});

test('Surface Integration — 2. 多 IDE 场景下缺少 source_endpoint 返回 HTTP 409 BLOCKED', async () => {
  const registry = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-multi-err',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br' },
    ide_endpoints: [
      { endpoint_id: 'ide-a', endpoint_revision: 1, conversation_id: 'c1', workspace_identity: '/w1', repository_identity: 'r1' },
      { endpoint_id: 'ide-b', endpoint_revision: 1, conversation_id: 'c2', workspace_identity: '/w2', repository_identity: 'r2' }
    ]
  });
  registry.registerProject({ binding });

  const { port, close } = await startStatusSurfaceServer({ registry });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/proj-multi-err/controls/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_binding_revision: 1,
        target_endpoint: 'browser'
      })
    });

    assert.strictEqual(res.status, 409);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.stage, 'BLOCKED');
    assert.match(json.reason, /SOURCE_ENDPOINT_REQUIRED/);
  } finally {
    await close();
  }
});

test('Surface Integration — 3. Surface 投影与 HTML 模板包含 Continue 按钮且不泄露 raw text', () => {
  const registry = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-ui-test',
    binding_revision: 1,
    browser: { provider: 'chatgpt', conversation_id: 'conv-ui-br' },
    ide: { conversation_id: 'conv-ui-ide', workspace_identity: '/ws', repository_identity: 'org/repo' }
  });
  const core = registry.registerProject({ binding });

  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-ui-br',
    trusted: true,
    latest_completed_cursor: 'cur-br-ui',
    latest_completed_result: {
      cursor: 'cur-br-ui',
      result_ref: 'res_br_safe_ref',
      text: 'SECRET RAW BODY TEXT',
      captured_at: '2026-09-18T10:00:00Z'
    }
  });

  const projection = projectStatusSurface(core.getSnapshot());

  // 验证 Projection 不泄露完整 text
  assert.strictEqual(projection.browser.result_ref, 'res_br_safe_ref');
  assert.strictEqual(projection.browser.has_result_material, true);
  assert.strictEqual('text' in projection.browser, false);
  assert.strictEqual(JSON.stringify(projection).includes('SECRET RAW BODY TEXT'), false);

  // 验证 HTML 模板包含 Continue 按钮
  const html = renderStatusSurfaceHtml({ projects: [projection] });
  assert.ok(html.includes('data-action="continue"'));
  assert.ok(html.includes('Continue'));
});
