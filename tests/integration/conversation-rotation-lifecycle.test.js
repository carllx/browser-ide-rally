/**
 * Issue #41 聚焦验收测试套件 (Conversation Rotation Lifecycle Acceptance Suite)
 * 
 * 依据 Browser Lead Mission Contract (Comment 5903121615):
 * 1. outgoing IDE = NEW -> valid target Rebind succeeds without discard flags
 * 2. old NEW fact remains retired and its handled cursor is unchanged
 * 3. outgoing IDE = UNKNOWN -> rotation succeeds without confirmation and old UNKNOWN evidence remains retired
 * 4. new IDE generation starts UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION
 * 5. valid new observation affects only active generation
 * 6. retired fact does not drive active red-dot/latest status
 * 7. restart preserves retired + active separation
 * 8. invalid/inaccessible target -> zero mutation / zero retirement
 * 9. stale binding revision -> zero mutation
 * 10. duplicate active target in another project -> zero mutation
 * 11. Hook install failure -> zero binding/retired-history mutation and old Hook remains valid
 * 12. successful Hook transition cleans only the old orphan
 * 13. Browser rotation follows the same non-destructive semantics
 * 14. ordinary Rebind UI contains no NEW/UNKNOWN discard controls or internal-state explanation
 * 15. existing #40 provider verification/identity derivation remains green
 * 16. full npm test green
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import { executeSafeRebind } from '../../src/controller/safe-rebind.js';
import { createStatusSurfaceRequestHandler } from '../../src/surface/surface-server.js';
import { projectStatusSurface } from '../../src/surface/surface-projection.js';


function makeSampleProject(id = 'proj-issue41') {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-br-initial',
      branch: 'feat/initial'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-initial',
        workspace_identity: '/ws/proj41',
        repository_identity: 'github.com/org/repo41'
      }
    ]
  });
}

describe('Issue #41: 非破坏性会话轮换核心验收 (Non-Destructive Conversation Rotation)', () => {
  test('1 & 2. outgoing IDE = NEW 时普通重绑无需任何 discard flags 成功，旧 NEW 事实退役且 handled cursor 不变', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-test-1') });

    // 1. 令 ide-primary 产生未处理 NEW 事实
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-initial',
      latest_completed_cursor: 'cursor-turn-100',
      completed_at: new Date().toISOString(),
      live_witnessed: true
    });

    const snapBefore = core.getSnapshot();
    assert.equal(snapBefore.endpoints.ide.result_state, 'NEW');
    assert.equal(snapBefore.endpoints.ide.latest_completed_cursor, 'cursor-turn-100');
    assert.equal(snapBefore.endpoints.ide.last_handled_cursor, null);

    // 2. 普通重绑：完全不携带 allow_discard_unhandled / allow_replace_unhandled 等标志
    const rebindRes = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-test-1',
      expectedBindingRevision: 1,
      targetEndpoint: 'ide-primary',
      newIdentity: {
        conversation_id: 'conv-ide-gen2',
        workspace_identity: '/ws/proj41',
        repository_identity: 'github.com/org/repo41'
      }
    });

    assert.equal(rebindRes.success, true);
    assert.equal(rebindRes.snapshot.binding.binding_revision, 2);
    assert.equal(rebindRes.action.stage, 'TARGET_COMPLETED');

    // 3. 验证退役账本：旧代际被完整归档，原游标绝未被标记为 handled
    const retired = core.getRetiredGenerations();
    assert.equal(retired.length, 1);
    const gen1 = retired[0];
    assert.equal(gen1.endpoint_id, 'ide-primary');
    assert.equal(gen1.endpoint_revision, 1);
    assert.equal(gen1.identity.conversation_id, 'conv-ide-initial');
    assert.equal(gen1.endpoint_fact.latest_completed_cursor, 'cursor-turn-100');
    assert.equal(gen1.endpoint_fact.last_handled_cursor, null, '旧 handled 游标绝不推进');
  });

  test('3 & 4. outgoing IDE = UNKNOWN 时轮换无需确认直接成功，旧证据归档，新代际 Fail-Closed 启动', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-test-3') });

    // 初始状态处于 UNKNOWN
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');

    // 普通轮换：无需任何 confirm_replace_unknown 标志
    const rebindRes = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-test-3',
      expectedBindingRevision: 1,
      targetEndpoint: 'ide-primary',
      newIdentity: {
        conversation_id: 'conv-ide-gen2',
        workspace_identity: '/ws/proj41',
        repository_identity: 'github.com/org/repo41'
      }
    });

    assert.equal(rebindRes.success, true);
    assert.equal(rebindRes.snapshot.binding.binding_revision, 2);

    // 新端点代际严格以 Fail-Closed 启动
    const snap = core.getSnapshot();
    const activeIde = snap.endpoints.ide;
    assert.equal(activeIde.result_state, 'UNKNOWN');
    assert.equal(activeIde.continuity.trusted, false);
    assert.equal(activeIde.continuity.unknown_reason, 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
    assert.equal(activeIde.latest_completed_cursor, null);
    assert.equal(activeIde.last_handled_cursor, null);

    // 旧代际归档在退役账本中
    const retired = core.getRetiredGenerations();
    assert.equal(retired.length, 1);
    assert.equal(retired[0].endpoint_id, 'ide-primary');
    assert.equal(retired[0].identity.conversation_id, 'conv-ide-initial');
  });

  test('5. 新代际观察仅作用于当前活跃端点，不污染退役代际；过时代际观察自动被隔离丢弃', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-test-5') });

    // 轮换至 revision 2
    reg.rebindProjectEndpoint('proj-test-5', {
      endpoint: 'ide-primary',
      identity: {
        conversation_id: 'conv-ide-gen2',
        workspace_identity: '/ws/proj41',
        repository_identity: 'github.com/org/repo41'
      }
    });

    // 1. 发送旧代际的过时观察 (endpoint_revision: 1) -> 必须被识别为 stale 丢弃 (NO-OP)
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-initial',
      latest_completed_cursor: 'cursor-stale-gen1'
    });
    assert.equal(core.getSnapshot().endpoints.ide.latest_completed_cursor, null, '活跃端点不受旧代际影响');

    // 2. 发送新代际的合法观察 (endpoint_revision: 2) -> 正常更新活跃端点
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      endpoint_id: 'ide-primary',
      endpoint_revision: 2,
      conversation_id: 'conv-ide-gen2',
      latest_completed_cursor: 'cursor-active-gen2'
    });
    assert.equal(core.getSnapshot().endpoints.ide.latest_completed_cursor, 'cursor-active-gen2');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');

    // 3. 验证退役代际保持不可变
    const retired = core.getRetiredGenerations();
    assert.equal(retired[0].endpoint_fact.latest_completed_cursor, null);
  });

  test('6. 退役代际事实绝不驱动当前活跃红点 (Latest Result Indicator) 或项目状态', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-test-6') });

    // 产生未处理 NEW 并打点在 IDE 端点
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-initial',
      latest_completed_cursor: 'cursor-ide-1',
      completed_at: new Date().toISOString(),
      live_witnessed: true
    });

    let projection = projectStatusSurface(core.getSnapshot());
    assert.equal(projection.latest_result_indicator, 'IDE_LATEST');
    assert.equal(projection.ide.is_latest_result, true);

    // 执行轮换：IDE 退休归档，新代际启动
    reg.rebindProjectEndpoint('proj-test-6', {
      endpoint: 'ide-primary',
      identity: {
        conversation_id: 'conv-ide-gen2',
        workspace_identity: '/ws/proj41',
        repository_identity: 'github.com/org/repo41'
      }
    });

    // 轮换后由于生命周期 rebaseline，旧已退休事实绝不驱动当前红点！
    projection = projectStatusSurface(core.getSnapshot());
    assert.equal(projection.ide.result_state, 'UNKNOWN');
    assert.equal(projection.ide.is_latest_result, false, '新代际尚未见证');
    assert.notEqual(projection.latest_result_indicator, 'IDE_LATEST', '退役代际绝不继续驱动红点');
  });

  test('7. 同一目标 (Same-Target) Rebind 绝不伪造新代际：彻底的零变异 No-Op (Browser + IDE)', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-same-target') });

    // 1. IDE 产生 NEW 事实
    core.recordEndpointObservation('ide-primary', {
      trusted: true,
      endpoint_id: 'ide-primary',
      endpoint_revision: 1,
      conversation_id: 'conv-ide-initial',
      latest_completed_cursor: 'cursor-turn-same',
      completed_at: new Date().toISOString()
    });
    const snapBeforeIde = core.getSnapshot();
    const actionsCountBefore = snapBeforeIde.actions.length;
    const updatedAtBefore = snapBeforeIde.updated_at;

    // 对 IDE 执行相同目标 Rebind
    const ideSameRes = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-same-target',
      expectedBindingRevision: 1,
      targetEndpoint: 'ide-primary',
      newIdentity: {
        conversation_id: 'conv-ide-initial',
        workspace_identity: '/ws/proj41',
        repository_identity: 'github.com/org/repo41'
      }
    });

    const snapAfterIde = core.getSnapshot();
    assert.equal(ideSameRes.success, true);
    assert.equal(ideSameRes.is_same_target, true);
    assert.equal(ideSameRes.action, null, 'Same-target 绝不得创建 Rebind Action');
    assert.equal(snapAfterIde.actions.length, actionsCountBefore, 'Action 账本数量绝对不变');
    assert.equal(snapAfterIde.updated_at, updatedAtBefore, '项目 updated_at 绝对不得变更');
    assert.equal(snapAfterIde.binding.binding_revision, 1, 'binding_revision 不得递增');
    assert.equal(snapAfterIde.binding.ide_endpoints[0].endpoint_revision, 1, 'endpoint_revision 不得递增');
    assert.equal(core.getRetiredGenerations().length, 0, '同一目标绝不得追加退役代际');
    assert.equal(snapAfterIde.endpoints.ide.result_state, 'NEW', '端点状态必须保持原样，绝不重置为 UNKNOWN');
    assert.equal(snapAfterIde.endpoints.ide.latest_completed_cursor, 'cursor-turn-same');

    // 2. 对 Browser 执行相同目标 Rebind
    core.recordEndpointObservation('browser', {
      trusted: true,
      conversation_id: 'conv-br-initial',
      latest_completed_cursor: 'cursor-br-same',
      completed_at: new Date().toISOString()
    });
    const snapBeforeBr = core.getSnapshot();
    const brActionsBefore = snapBeforeBr.actions.length;
    const brUpdatedAtBefore = snapBeforeBr.updated_at;

    const brSameRes = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-same-target',
      expectedBindingRevision: 1,
      targetEndpoint: 'browser',
      newIdentity: {
        provider: 'chatgpt',
        conversation_id: 'conv-br-initial',
        branch: 'feat/initial'
      }
    });

    const snapAfterBr = core.getSnapshot();
    assert.equal(brSameRes.success, true);
    assert.equal(brSameRes.is_same_target, true);
    assert.equal(brSameRes.action, null, 'Browser same-target 绝不创建 Action');
    assert.equal(snapAfterBr.actions.length, brActionsBefore, 'Browser same-target 不新增 Action');
    assert.equal(snapAfterBr.updated_at, brUpdatedAtBefore, 'Browser same-target 不修改 updated_at');
    assert.equal(snapAfterBr.binding.binding_revision, 1, 'Browser 同一目标 binding_revision 不变');
    assert.equal(core.getRetiredGenerations().length, 0, 'Browser 同一目标绝不追加退役代际');
    assert.equal(snapAfterBr.endpoints.browser.result_state, 'NEW', 'Browser 事实绝不重置');
    assert.equal(snapAfterBr.endpoints.browser.latest_completed_cursor, 'cursor-br-same');
  });

  test('8 & 9. 安全门禁严格保持：无效目标/版本过期均实行零变更拦截 (Zero Mutation)', () => {
    const reg = createProjectRegistry();
    const core1 = reg.registerProject({ binding: makeSampleProject('proj-p1') });
    const revBefore = core1.getSnapshot().binding.binding_revision;

    // 8. 缺少必要身份字段（无效目标）：拦截抛错，零变更，零退役
    assert.throws(() => {
      executeSafeRebind({
        registry: reg,
        projectBindingId: 'proj-p1',
        expectedBindingRevision: revBefore,
        targetEndpoint: 'ide-primary',
        newIdentity: { conversation_id: 'only-conv-no-ws' }
      });
    }, /requires conversation_id, workspace_identity, and repository_identity/);
    assert.equal(core1.getSnapshot().binding.binding_revision, revBefore);
    assert.equal(core1.getRetiredGenerations().length, 0);

    // 9. 版本过期 (stale revision)：拦截抛错，零变更
    assert.throws(() => {
      executeSafeRebind({
        registry: reg,
        projectBindingId: 'proj-p1',
        expectedBindingRevision: 999,
        targetEndpoint: 'ide-primary',
        newIdentity: {
          conversation_id: 'conv-valid',
          workspace_identity: '/ws/proj41',
          repository_identity: 'github.com/org/repo41'
        }
      });
    }, /STALE_OR_MISSING_BINDING_REVISION/);
    assert.equal(core1.getSnapshot().binding.binding_revision, revBefore);
    assert.equal(core1.getRetiredGenerations().length, 0);
  });


  test('11 & 12. Hook 过渡原子性：Hook 安装失败零变更且旧 Hook 完好；成功过渡后仅清理旧孤立订阅', async () => {
    let server;
    try {
      const mockCoordinator = {
        workspaceHookManager: {
          ensureWorkspaceHook(ws, conv) {
            if (conv === 'conv-fail-hook') {
              return { success: false, reason: 'SIMULATED_HOOK_INSTALL_FAIL' };
            }
            return { success: true, newlySubscribed: true };
          },
          removeCalls: [],
          removeWorkspaceHook(ws, conv) {
            this.removeCalls.push({ ws, conv });
          }
        }
      };

      const reg = createProjectRegistry();
      const core = reg.registerProject({ binding: makeSampleProject('proj-hook-atomicity') });

      // 启动轻量 surface server 进行原子性测试
      const testSessionToken = 'test-token-rotation-lifecycle';
      const app = createStatusSurfaceRequestHandler({
        registry: reg,
        observationCoordinator: mockCoordinator,
        sessionToken: testSessionToken,
        agentapiResolver: { resolveAgentapiExecutable: () => '/bin/echo' },
        agentApiExecutor: (bin, args) => {
          const convId = args[args.length - 1];
          const ws = convId === 'conv-fail-hook' ? '/ws/fail' : '/ws/new';
          const repo = convId === 'conv-fail-hook' ? 'org/fail' : 'org/new';
          return JSON.stringify({
            response: {
              conversationMetadata: {
                metadata: {
                  workspaces: [
                    {
                      workspaceFolderAbsoluteUri: `file://${ws}`,
                      repository: { computedName: repo }
                    }
                  ]
                }
              }
            }
          });
        }
      });
      server = http.createServer(app);
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. Hook 安装失败用例
      const failRes = await fetch(`${baseUrl}/api/projects/proj-hook-atomicity/controls/rebind`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rally-Session-Token': testSessionToken,
          Connection: 'close'
        },
        body: JSON.stringify({
          expected_binding_revision: 1,
          target_endpoint: 'ide-primary',
          new_identity: {
            conversation_id: 'conv-fail-hook',
            workspace_identity: '/ws/fail',
            repository_identity: 'org/fail'
          }
        })
      });
      assert.ok([400, 409].includes(failRes.status));
      const failData = await failRes.json();
      assert.match(failData.reason, /WORKSPACE_HOOK_FAILED/);
      // 零变更：版本不变，退役账本为空
      assert.equal(core.getSnapshot().binding.binding_revision, 1);
      assert.equal(core.getRetiredGenerations().length, 0);

      // 2. Hook 成功过渡用例
      const okRes = await fetch(`${baseUrl}/api/projects/proj-hook-atomicity/controls/rebind`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rally-Session-Token': testSessionToken,
          Connection: 'close'
        },
        body: JSON.stringify({
          expected_binding_revision: 1,
          target_endpoint: 'ide-primary',
          new_identity: {
            conversation_id: 'conv-success-hook',
            workspace_identity: '/ws/new',
            repository_identity: 'org/new'
          }
        })
      });
      assert.equal(okRes.status, 200);
      assert.equal(core.getSnapshot().binding.binding_revision, 2);
      assert.equal(core.getRetiredGenerations().length, 1);

      // 验证仅清理了旧孤立会话 conv-ide-initial
      assert.equal(mockCoordinator.workspaceHookManager.removeCalls.length, 1);
      assert.equal(mockCoordinator.workspaceHookManager.removeCalls[0].conv, 'conv-ide-initial');
    } finally {
      if (server) {
        server.close();
        server.closeAllConnections?.();
      }
    }
  });

  test('13. Browser 端点轮换遵循完全相同的非破坏性代际保留语义', () => {
    const reg = createProjectRegistry();
    const core = reg.registerProject({ binding: makeSampleProject('proj-browser-rot') });

    // 让 Browser 处于未处理 NEW
    core.recordEndpointObservation('browser', {
      trusted: true,
      conversation_id: 'conv-br-initial',
      latest_completed_cursor: 'cursor-br-new',
      completed_at: new Date().toISOString()
    });
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

    // 普通轮换：无需任何 discard 标志
    const rebindRes = executeSafeRebind({
      registry: reg,
      projectBindingId: 'proj-browser-rot',
      expectedBindingRevision: 1,
      targetEndpoint: 'browser',
      newIdentity: {
        conversation_id: 'conv-br-rotated',
        branch: 'feat/new-browser-branch'
      }
    });

    assert.equal(rebindRes.success, true);
    assert.equal(rebindRes.snapshot.binding.binding_revision, 2);
    assert.equal(rebindRes.snapshot.binding.browser.conversation_id, 'conv-br-rotated');
    assert.equal(rebindRes.snapshot.binding.browser.branch, 'feat/new-browser-branch');

    // 新端点以 Fail-Closed 启动
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.equal(core.getSnapshot().endpoints.browser.last_handled_cursor, null);

    // 旧代际完整归档
    const retired = core.getRetiredGenerations();
    assert.equal(retired.length, 1);
    assert.equal(retired[0].role, 'browser');
    assert.equal(retired[0].identity.conversation_id, 'conv-br-initial');
    assert.equal(retired[0].endpoint_fact.latest_completed_cursor, 'cursor-br-new');
    assert.equal(retired[0].endpoint_fact.last_handled_cursor, null);
  });

  test('14. 普通 Rebind UI 严格遵循 #42 门禁：不包含 NEW/UNKNOWN 丢弃复选框或状态机解释', async () => {
    const reg = createProjectRegistry();
    reg.registerProject({ binding: makeSampleProject('proj-ui-gate') });
    const app = createStatusSurfaceRequestHandler({ registry: reg });
    const server = http.createServer(app);
    try {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;

      const htmlRes = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Connection: 'close' }
      });
      const html = await htmlRes.text();

      // 1. 严格禁止出现 NEW/UNKNOWN 丢弃复选框
      assert.doesNotMatch(html, /m-allow-unhandled/, '普通 UI 严禁包含 m-allow-unhandled 勾选框');
      assert.doesNotMatch(html, /m-allow-unknown/, '普通 UI 严禁包含 m-allow-unknown 勾选框');
      assert.doesNotMatch(html, /强制替换未处理 NEW 事实/);
      assert.doesNotMatch(html, /确认替换处于 UNKNOWN 的端点/);

      // 2. 严格禁止在弹窗中倾倒状态机术语或代际退役长篇说明
      assert.doesNotMatch(html, /REBIND_UNHANDLED/);
      assert.doesNotMatch(html, /目标端点当前存在未处理的 NEW 事实/);
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  });
});
