/**
 * Browser Rebind 完整 ChatGPT URL 输入端到端集成测试套件 (#39)
 * 
 * 权威验收契约 (Browser Mission Contract 5912607857):
 * 1. https://chatgpt.com/c/<id> 派生精确 ID 并经由安全非破坏性轮换成功；
 * 2. https://chat.openai.com/c/<id> 成功；
 * 3. https://chatgpt.com/g/<gpt>/c/<id> 成功；
 * 4. 带 query/hash/trailing slash 变体归一化为相同的精确 ID；
 * 5. 合法的裸 ID (Bare Exact ID) 兼容正常工作；
 * 6. 畸形/非 ChatGPT/不支持的 URL 严格拦截（零版本变化、零端点变化、零退役追加）；
 * 7. 完整 URL 绝对不作为 conversation_id 落盘持久化；
 * 8. Same-target URL（解析为当前活跃身份）严格保持 #41 的真正零变异 No-Op；
 * 9. 跨项目已占用的 ChatGPT URL 解析后被规范唯一性守卫拦截；
 * 10. Onboarding parser 回归保持不变；
 * 11. IDE Rebind 行为与回归保持不受影响；
 * 12. 全量 npm test 绿灯。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import { executeSafeRebind } from '../../src/controller/safe-rebind.js';
import { createStatusSurfaceRequestHandler } from '../../src/surface/surface-server.js';
import { parseChatGPTConversationUrl } from '../../src/surface/chatgpt-conversation-parser.js';

function createTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-rebind-url-'));
  const file = path.join(dir, 'projects.json');
  return {
    file,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  };
}

function makeSampleProject(id = 'proj-url-test', browserConvId = 'conv-br-init', ideConvId = null) {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    display_name: `Test Project ${id}`,
    browser: {
      provider: 'chatgpt',
      conversation_id: browserConvId,
      branch: 'main'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: ideConvId || `conv-ide-${id}`,
        workspace_identity: `/ws/${id}`,
        repository_identity: 'github.com/org/repo'
      }
    ]
  });
}

/**
 * 启动临时 HTTP 服务用于真实请求测试
 */
function createTestHttpServer(registry) {
  const handler = createStatusSurfaceRequestHandler({ registry });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

describe('Issue #39: Browser Rebind Full ChatGPT URL Input Integration', () => {
  test('1. 输入 https://chatgpt.com/c/<id> 精确派生 ID 并成功执行非破坏性轮换', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-1', 'conv-br-initial') });

    const targetUrl = 'https://chatgpt.com/c/6774a3f1-0001-4000-8000-000000000001';
    const result = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-1',
      expectedBindingRevision: 1,
      targetEndpoint: 'browser',
      identity: {
        conversation_id: targetUrl,
        branch: 'feat-new'
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.is_same_target, false);
    const snap = result.snapshot;
    // 派生出的 exact ID 被写入规范状态，绝对不是完整 URL
    assert.equal(snap.binding.browser.conversation_id, '6774a3f1-0001-4000-8000-000000000001');
    assert.equal(snap.binding.browser.branch, 'feat-new');
    assert.equal(snap.binding.binding_revision, 2);

    // 原有代际进入退役历史，且记录的是原有的规范 ID
    const retired = core.getRetiredGenerations();
    assert.equal(retired.length, 1);
    assert.equal(retired[0].identity.conversation_id, 'conv-br-initial');
  });

  test('2 & 3. 支持 https://chat.openai.com/c/<id> 与 https://chatgpt.com/g/<gpt>/c/<id>', () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: makeSampleProject('proj-legacy-domain') });

    // 2. chat.openai.com
    const res1 = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-legacy-domain',
      expectedBindingRevision: 1,
      targetEndpoint: 'browser',
      identity: { conversation_id: 'https://chat.openai.com/c/conv-classic-abc' }
    });
    assert.equal(res1.snapshot.binding.browser.conversation_id, 'conv-classic-abc');

    // 3. chatgpt.com/g/<gpt>/c/<id>
    const res2 = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-legacy-domain',
      expectedBindingRevision: 2,
      targetEndpoint: 'browser',
      identity: { conversation_id: 'https://chatgpt.com/g/g-2DQzUNuik-code-copilot/c/conv-gpts-xyz' }
    });
    assert.equal(res2.snapshot.binding.browser.conversation_id, 'conv-gpts-xyz');
  });

  test('4. 附带 query、hash 与尾随斜杠的变体均归一化为相同的 exact ID', () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: makeSampleProject('proj-variants') });

    const urlWithParams = 'https://chatgpt.com/c/conv-variant-target?model=gpt-4o#bottom';
    const res = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-variants',
      expectedBindingRevision: 1,
      targetEndpoint: 'browser',
      identity: { conversation_id: urlWithParams }
    });

    assert.equal(res.snapshot.binding.browser.conversation_id, 'conv-variant-target');
  });

  test('5. 保持合法裸 ID (Bare Exact ID) 的完整兼容性', () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: makeSampleProject('proj-bare') });

    const bareId = '6774a3f1-0002-4000-8000-000000000002';
    const res = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-bare',
      expectedBindingRevision: 1,
      targetEndpoint: 'browser',
      identity: { conversation_id: bareId }
    });

    assert.equal(res.snapshot.binding.browser.conversation_id, bareId);
  });

  test('6. 畸形/非 ChatGPT/不支持的 URL 严格拦截：零变异且不追加退役代际', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-invalid') });

    const snapBefore = core.getSnapshot();
    const revBefore = snapBefore.binding.binding_revision;
    const actionsBefore = snapBefore.actions.length;
    const updatedAtBefore = snapBefore.updated_at;

    const invalidInputs = [
      'https://google.com/search?q=chatgpt',
      'https://chatgpt.com/',
      '/c/conv-relative',
      'chatgpt.com/c/no-protocol',
      'ftp://chatgpt.com/c/bad-proto',
      'invalid token with space'
    ];

    for (const badInput of invalidInputs) {
      assert.throws(() => {
        executeSafeRebind({
          registry: reg,
          projectBindingId: 'proj-invalid',
          expectedBindingRevision: revBefore,
          targetEndpoint: 'browser',
          identity: { conversation_id: badInput }
        });
      }, /INVALID_CHATGPT_CONVERSATION/);

      // 验证严格零变异
      const snapAfter = core.getSnapshot();
      assert.equal(snapAfter.binding.binding_revision, revBefore, '绑定版本严禁递增');
      assert.equal(snapAfter.actions.length, actionsBefore, '严禁生成 Action');
      assert.equal(snapAfter.updated_at, updatedAtBefore, 'updated_at 不得变异');
      assert.equal(core.getRetiredGenerations().length, 0, '严禁追加退役记录');
    }
  });

  test('7. 完整 URL 绝对不作为 conversation_id 落盘持久化', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const reg = createProjectRegistry({ storagePath: file });
      reg.registerProject({ binding: makeSampleProject('proj-persist-check') });

      executeSafeRebind({
        registry: reg,
        projectBindingId: 'proj-persist-check',
        expectedBindingRevision: 1,
        targetEndpoint: 'browser',
        identity: { conversation_id: 'https://chatgpt.com/c/conv-persisted-exact-id?ref=test' }
      });

      // 重新读取持久化 JSON 文件
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const persistedBrowser = raw.projects['proj-persist-check'].binding.browser;
      assert.equal(persistedBrowser.conversation_id, 'conv-persisted-exact-id');
      assert.ok(!persistedBrowser.conversation_id.includes('https://'));
      assert.ok(!persistedBrowser.conversation_id.includes('chatgpt.com'));

      // 重启并重新加载验证
      const reg2 = createProjectRegistry({ storagePath: file });
      const snap = reg2.getProject('proj-persist-check').getSnapshot();
      assert.equal(snap.binding.browser.conversation_id, 'conv-persisted-exact-id');
    } finally {
      cleanup();
    }
  });

  test('8. 输入解析为当前活跃身份的 Same-Target URL 严格保持 #41 真正的零变异 No-Op', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({
      binding: makeSampleProject('proj-same-target', 'conv-active-current')
    });

    const snapBefore = core.getSnapshot();
    const revBefore = snapBefore.binding.binding_revision;
    const actionsBefore = snapBefore.actions.length;
    const updatedAtBefore = snapBefore.updated_at;

    // 传入当前会话的完整 URL (包含 query 与 branch 一致)
    const sameTargetUrl = 'https://chatgpt.com/c/conv-active-current?model=gpt-4o';
    const res = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-same-target',
      expectedBindingRevision: revBefore,
      targetEndpoint: 'browser',
      identity: {
        conversation_id: sameTargetUrl,
        branch: 'main'
      }
    });

    assert.equal(res.success, true);
    assert.equal(res.is_same_target, true, '同目标 URL 输入必须精确识别为 same target');
    assert.equal(res.action, null, '同目标严禁创建 Action');

    const snapAfter = core.getSnapshot();
    assert.equal(snapAfter.binding.binding_revision, revBefore, '同目标版本严禁递增');
    assert.equal(snapAfter.actions.length, actionsBefore, '不得创建任何 Action');
    assert.equal(snapAfter.updated_at, updatedAtBefore, 'updated_at 不得变异');
    assert.equal(core.getRetiredGenerations().length, 0, '不得追加退役代际');
  });

  test('9. 跨项目已占用的 ChatGPT URL 在解析后被规范唯一性守卫拦截', () => {
    const reg = createProjectRegistry();
    reg.registerProject({
      binding: makeSampleProject('proj-occupied-1', 'conv-shared-uuid')
    });
    const core2 = reg.registerProject({
      binding: makeSampleProject('proj-occupied-2', 'conv-other-br')
    });

    const revBefore = core2.getSnapshot().binding.binding_revision;

    // 尝试在项目 2 将 Browser 重绑到项目 1 正在使用的同一 ChatGPT 会话 URL
    assert.throws(() => {
      executeSafeRebind({
        registry: reg,
        projectBindingId: 'proj-occupied-2',
        expectedBindingRevision: 1,
        targetEndpoint: 'browser',
        identity: { conversation_id: 'https://chatgpt.com/c/conv-shared-uuid' }
      });
    }, /Browser conversation "conv-shared-uuid" is already bound to project/);

    // 验证零变异
    assert.equal(core2.getSnapshot().binding.binding_revision, revBefore);
    assert.equal(core2.getRetiredGenerations().length, 0);
  });

  test('10. Onboarding 既有 parseChatGPTConversationUrl 回归保持不变', () => {
    // 验证 parseChatGPTConversationUrl 依然保持严格 URL 校验契约
    assert.equal(
      parseChatGPTConversationUrl('https://chatgpt.com/c/conv-onboarding-test'),
      'conv-onboarding-test'
    );
    // 依然拒绝裸 ID（保证 onboarding 不受非预期影响）
    assert.throws(
      () => parseChatGPTConversationUrl('conv-onboarding-test'),
      /Invalid ChatGPT conversation URL/
    );
  });

  test('11. IDE Rebind 行为与回归保持不受任何影响', () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: makeSampleProject('proj-ide-check') });

    // IDE 重绑仍接受裸会话 ID，且保留自动派生
    const res = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-ide-check',
      expectedBindingRevision: 1,
      targetEndpoint: 'ide-primary',
      identity: {
        conversation_id: 'conv-ide-next',
        workspace_identity: '/ws/url-test',
        repository_identity: 'github.com/org/repo'
      }
    });

    assert.equal(res.success, true);
    assert.equal(res.snapshot.binding.ide_endpoints[0].conversation_id, 'conv-ide-next');
  });

  test('12. 真实 HTTP 端点验证 (POST /api/projects/:id/controls/rebind)', async () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: makeSampleProject('proj-http-test', 'conv-http-init') });

    const server = await createTestHttpServer(reg);
    try {
      // 12a. 提交合法完整 ChatGPT URL
      const postUrlSuccess = await fetch(`${server.url}/api/projects/proj-http-test/controls/rebind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_binding_revision: 1,
          target_endpoint: 'browser',
          new_identity: {
            conversation_id: 'https://chatgpt.com/c/6774a3f1-http-test-0001?model=gpt-4o',
            branch: 'feat-http'
          }
        })
      });

      assert.equal(postUrlSuccess.status, 200);
      const dataSuccess = await postUrlSuccess.json();
      assert.equal(dataSuccess.success, true);
      assert.equal(dataSuccess.new_binding_revision, 2);

      const snap = reg.getProject('proj-http-test').getSnapshot();
      assert.equal(snap.binding.browser.conversation_id, '6774a3f1-http-test-0001');
      assert.equal(snap.binding.browser.branch, 'feat-http');

      // 12b. 提交非 ChatGPT 链接，验证友好错误返回且零变异
      const postUrlFail = await fetch(`${server.url}/api/projects/proj-http-test/controls/rebind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_binding_revision: 2,
          target_endpoint: 'browser',
          new_identity: {
            conversation_id: 'https://google.com/search?q=test'
          }
        })
      });

      assert.equal(postUrlFail.status, 409);
      const dataFail = await postUrlFail.json();
      assert.equal(dataFail.success, false);
      assert.match(dataFail.reason, /INVALID_CHATGPT_CONVERSATION/);

      // 状态与版本未受影响
      assert.equal(reg.getProject('proj-http-test').getSnapshot().binding.binding_revision, 2);
    } finally {
      await server.close();
    }
  });
});
