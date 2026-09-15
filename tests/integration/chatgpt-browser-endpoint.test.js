/**
 * Browser Endpoint Integration Matrix (#15)
 * 
 * 测试接缝：
 * ChatGPTBrowserAdapter facts → normalized observation → durable ProjectRegistry / Status Core → externally visible Browser Endpoint Result.
 * 
 * 严格覆盖 #15 Acceptance Criteria:
 * 1. exact bound conversation attribution: 唯一定位成功；0 匹配或多匹配 fail-closed 到 UNKNOWN；
 * 2. placeholder / unfinished generation: button[data-testid="stop-button"] 或无 data-message-id 绝不提交完成游标；
 * 3. 产生可靠完成: 改变 Browser endpoint result 从 caught-up/NO_NEW_RESULT 到 NEW，IDE endpoint 事实分毫未动；
 * 4. 游标去重与幂等: 重复观察相同的 opaque cursor 不会生成重复 NEW，也不会破坏 handled 状态；
 * 5. 显式 Mark handled: Browser 回到 NO_NEW_RESULT，IDE 保持不变；
 * 6. 重启去重 (Restart Dedup): durable registry 重启后恢复 handled 游标，绝不将已处理完成回放为 NEW；
 * 7. 重启后精确单次推进: 重启后下一次真实的完成游标精准推进一次到 NEW；
 * 8. 漂移与失配 Fail-Closed: stale revision / 错误 conversationId / DOM 探测失败均导致 UNKNOWN，绝不猜想；
 * 9. 隔离性守卫: 确保没有泄漏任何 ChatGPT DOM 选择器、message-id 格式到 Core 持久化结构中，也不引入任何 owner/branch 推断。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatGPTBrowserAdapter } from '../../src/adapters/browser/chatgpt-browser-adapter.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

function createTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-browser-test-'));
  return path.join(dir, 'registry.json');
}

describe('Browser Endpoint Result 集成测试矩阵 (#15)', () => {
  const targetConvId = '6aa8de2c-24c8-83ea-a807-4d7780add444';
  const dummyIdeConvId = 'ide-antigravity-conv-001';

  const baseBinding = createBinding({
    binding_id: 'rally-project-alpha',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: targetConvId
    },
    ide: {
      conversation_id: dummyIdeConvId,
      workspace_identity: 'ws-alpha',
      repository_identity: 'repo-alpha'
    }
  });

  it('1. 精确绑定的 ChatGPT 会话唯一定位成功；0 匹配或多匹配 fail-closed 为 UNKNOWN', () => {
    // A. 唯一匹配
    const uniqueExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/g/g-p-123/c/${targetConvId}`;
      }
      return JSON.stringify({ isGenerating: false, assistantCount: 0, lastMessageId: null, hasValidLastMessage: false });
    };
    const adapterA = new ChatGPTBrowserAdapter({ executor: uniqueExecutor });
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding: baseBinding });

    const obsA = adapterA.observeBrowserEndpoint({
      conversationId: baseBinding.browser.conversation_id,
      bindingRevision: baseBinding.binding_revision
    });
    core.recordEndpointObservation('browser', obsA);
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

    // B. 0 匹配：fail-closed 到 UNKNOWN
    const zeroMatchExecutor = () => 'ERROR:ZERO_MATCHES';
    const adapterB = new ChatGPTBrowserAdapter({ executor: zeroMatchExecutor });
    const obsB = adapterB.observeBrowserEndpoint({
      conversationId: baseBinding.browser.conversation_id,
      bindingRevision: baseBinding.binding_revision
    });
    core.recordEndpointObservation('browser', obsB);
    const snapB = core.getSnapshot().endpoints.browser;
    assert.equal(snapB.result_state, 'UNKNOWN');
    assert.match(snapB.unknown_reason, /No Chrome tab found/);

    // C. 多匹配（存在歧义）：fail-closed 到 UNKNOWN
    const multiMatchExecutor = () => 'ERROR:AMBIGUOUS_MATCHES:3';
    const adapterC = new ChatGPTBrowserAdapter({ executor: multiMatchExecutor });
    const obsC = adapterC.observeBrowserEndpoint({
      conversationId: baseBinding.browser.conversation_id,
      bindingRevision: baseBinding.binding_revision
    });
    core.recordEndpointObservation('browser', obsC);
    const snapC = core.getSnapshot().endpoints.browser;
    assert.equal(snapC.result_state, 'UNKNOWN');
    assert.match(snapC.unknown_reason, /Ambiguous match: 3 tabs/);
  });

  it('2. 生成中 (stop-button) 与占位轮次 (placeholder) 绝不提交完成游标，保持或进入 UNKNOWN', () => {
    const storagePath = createTempStorage();
    const registry = createProjectRegistry({ storagePath });
    const core = registry.registerProject({ binding: baseBinding });

    // 初始状态为 UNKNOWN
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');

    // A. 正在生成中 (button[data-testid="stop-button"])
    const generatingExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: true,
        assistantCount: 2,
        lastMessageId: 'temp-streaming-id',
        hasValidLastMessage: true,
        isPlaceholder: false
      });
    };
    const adapterGenerating = new ChatGPTBrowserAdapter({ executor: generatingExecutor });
    const obsGen = adapterGenerating.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });
    core.recordEndpointObservation('browser', obsGen);
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.equal(core.getSnapshot().endpoints.browser.latest_completed_cursor, null);

    // B. 生成停止但处于占位状态 (例如 data-message-id 尚不可用)
    const placeholderExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: false,
        assistantCount: 2,
        lastMessageId: null,
        hasValidLastMessage: false,
        isPlaceholder: true
      });
    };
    const adapterPlaceholder = new ChatGPTBrowserAdapter({ executor: placeholderExecutor });
    const obsPlaceholder = adapterPlaceholder.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });
    core.recordEndpointObservation('browser', obsPlaceholder);
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.equal(core.getSnapshot().endpoints.browser.latest_completed_cursor, null);
  });

  it('3. 可靠完成使 Browser 状态从 caught-up 变为 NEW，而 IDE 端点状态与规范事实毫发无损', () => {
    const storagePath = createTempStorage();
    const registry = createProjectRegistry({ storagePath });
    const core = registry.registerProject({ binding: baseBinding });

    // 先建立两端 caught-up (NO_NEW_RESULT) 基线
    core.recordEndpointObservation('ide', {
      conversation_id: dummyIdeConvId,
      binding_revision: 1,
      latest_completed_cursor: 'ide_turn_0',
      trusted: true
    });
    core.markEndpointHandled('ide', { expected_cursor: 'ide_turn_0' });
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');

    const caughtUpBrowserExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({ isGenerating: false, assistantCount: 0, lastMessageId: null, hasValidLastMessage: false });
    };
    const caughtUpAdapter = new ChatGPTBrowserAdapter({ executor: caughtUpBrowserExecutor });
    core.recordEndpointObservation('browser', caughtUpAdapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    }));
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

    // 记录此时 IDE 的快照基线
    const ideSnapshotBefore = { ...core.getSnapshot().endpoints.ide };

    // 观察到 Browser 产生可靠的完成轮次
    const turn1MsgId = '9b42e774-8d48-43d9-a78c-02cf30a08e1a';
    const completedExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: false,
        assistantCount: 1,
        lastMessageId: turn1MsgId,
        hasValidLastMessage: true,
        isPlaceholder: false
      });
    };
    const completedAdapter = new ChatGPTBrowserAdapter({ executor: completedExecutor });
    const completedObs = completedAdapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    });

    core.recordEndpointObservation('browser', completedObs);

    const snapshotAfter = core.getSnapshot();
    // Browser 变成 NEW
    assert.equal(snapshotAfter.endpoints.browser.result_state, 'NEW');
    assert.equal(snapshotAfter.endpoints.browser.latest_completed_cursor, `chatgpt_msg_${turn1MsgId}`);
    assert.equal(snapshotAfter.endpoints.browser.last_handled_cursor, null);

    // IDE 严格未受任何影响
    assert.equal(snapshotAfter.endpoints.ide.result_state, ideSnapshotBefore.result_state);
    assert.equal(snapshotAfter.endpoints.ide.latest_completed_cursor, ideSnapshotBefore.latest_completed_cursor);
    assert.equal(snapshotAfter.endpoints.ide.last_handled_cursor, ideSnapshotBefore.last_handled_cursor);
  });

  it('4. 相同完成游标的重复观察具备幂等性，不产生重复 NEW 且不破坏 handled 状态', () => {
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding: baseBinding });
    const turn1MsgId = '9b42e774-8d48-43d9-a78c-02cf30a08e1a';

    const completedExecutor = (script) => {
      if (script.includes('set matchCount to 0')) {
        return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
      }
      return JSON.stringify({
        isGenerating: false,
        assistantCount: 1,
        lastMessageId: turn1MsgId,
        hasValidLastMessage: true,
        isPlaceholder: false
      });
    };
    const adapter = new ChatGPTBrowserAdapter({ executor: completedExecutor });

    // 第一次观察：变为 NEW
    core.recordEndpointObservation('browser', adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    }));
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

    // 第二次观察相同内容：仍然为 NEW，游标不变
    core.recordEndpointObservation('browser', adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    }));
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
    assert.equal(core.getSnapshot().endpoints.browser.latest_completed_cursor, `chatgpt_msg_${turn1MsgId}`);

    // 显式 Mark handled
    core.markEndpointHandled('browser', { expected_cursor: `chatgpt_msg_${turn1MsgId}` });
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

    // 第三次观察相同内容：由于 handled cursor 已经记录，保持 NO_NEW_RESULT，绝不重新变 NEW
    core.recordEndpointObservation('browser', adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    }));
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
  });

  it('5. Mark handled 将 Browser 回归到 NO_NEW_RESULT，IDE 状态保持独立', () => {
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding: baseBinding });
    const turn1MsgId = '9b42e774-8d48-43d9-a78c-02cf30a08e1a';

    const adapter = new ChatGPTBrowserAdapter({
      executor: (script) => {
        if (script.includes('set matchCount to 0')) {
          return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
        }
        return JSON.stringify({
          isGenerating: false,
          assistantCount: 1,
          lastMessageId: turn1MsgId,
          hasValidLastMessage: true,
          isPlaceholder: false
        });
      }
    });

    core.recordEndpointObservation('browser', adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    }));
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

    // Mark handled
    core.markEndpointHandled('browser', { expected_cursor: `chatgpt_msg_${turn1MsgId}` });
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(core.getSnapshot().endpoints.browser.last_handled_cursor, `chatgpt_msg_${turn1MsgId}`);
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');
  });

  it('6. 重启去重 (Restart Dedup) & 7. 重启后精确单次推进', () => {
    const storagePath = createTempStorage();
    const turn1MsgId = '9b42e774-8d48-43d9-a78c-02cf30a08e1a';
    const turn2MsgId = '0b01c43a-2ca6-4c1a-8b1e-e2823f8c03f6';

    // 实例 1：产生 turn 1 并 mark handled，然后落盘
    {
      const registry1 = createProjectRegistry({ storagePath });
      const core1 = registry1.registerProject({ binding: baseBinding });

      const adapter1 = new ChatGPTBrowserAdapter({
        executor: (script) => {
          if (script.includes('set matchCount to 0')) {
            return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
          }
          return JSON.stringify({
            isGenerating: false,
            assistantCount: 1,
            lastMessageId: turn1MsgId,
            hasValidLastMessage: true,
            isPlaceholder: false
          });
        }
      });

      core1.recordEndpointObservation('browser', adapter1.observeBrowserEndpoint({
        conversationId: targetConvId,
        bindingRevision: 1
      }));
      assert.equal(core1.getSnapshot().endpoints.browser.result_state, 'NEW');

      core1.markEndpointHandled('browser', { expected_cursor: `chatgpt_msg_${turn1MsgId}` });
      assert.equal(core1.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

      registry1.saveToFile(storagePath);
    }

    // 实例 2：从存储恢复（模拟系统重启）
    {
      const registry2 = createProjectRegistry({ storagePath });
      const core2 = registry2.getProject(baseBinding.binding_id);

      // 6. 重启后立即可见：由于 turn 1 已经 handled，派生结果必须为 NO_NEW_RESULT，绝不回放为 NEW！
      const snapRestored = core2.getSnapshot().endpoints.browser;
      assert.equal(snapRestored.result_state, 'NO_NEW_RESULT');
      assert.equal(snapRestored.latest_completed_cursor, `chatgpt_msg_${turn1MsgId}`);
      assert.equal(snapRestored.last_handled_cursor, `chatgpt_msg_${turn1MsgId}`);

      // 再次观察已由 adapter 返回的旧 turn 1：仍然保持 NO_NEW_RESULT
      const adapterOldTurn = new ChatGPTBrowserAdapter({
        executor: (script) => {
          if (script.includes('set matchCount to 0')) {
            return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
          }
          return JSON.stringify({
            isGenerating: false,
            assistantCount: 1,
            lastMessageId: turn1MsgId,
            hasValidLastMessage: true,
            isPlaceholder: false
          });
        }
      });
      core2.recordEndpointObservation('browser', adapterOldTurn.observeBrowserEndpoint({
        conversationId: targetConvId,
        bindingRevision: 1
      }));
      assert.equal(core2.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

      // 7. 真实产生新轮次 turn 2：精确推进一次到 NEW
      const adapterNewTurn = new ChatGPTBrowserAdapter({
        executor: (script) => {
          if (script.includes('set matchCount to 0')) {
            return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
          }
          return JSON.stringify({
            isGenerating: false,
            assistantCount: 2,
            lastMessageId: turn2MsgId,
            hasValidLastMessage: true,
            isPlaceholder: false
          });
        }
      });
      core2.recordEndpointObservation('browser', adapterNewTurn.observeBrowserEndpoint({
        conversationId: targetConvId,
        bindingRevision: 1
      }));

      const snapNewTurn = core2.getSnapshot().endpoints.browser;
      assert.equal(snapNewTurn.result_state, 'NEW');
      assert.equal(snapNewTurn.latest_completed_cursor, `chatgpt_msg_${turn2MsgId}`);
      assert.equal(snapNewTurn.last_handled_cursor, `chatgpt_msg_${turn1MsgId}`);
    }
  });

  it('8. 会话不匹配与过时版本观察严格 fail-closed 为 UNKNOWN', () => {
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding: baseBinding });

    // A. 错误 conversationId 的观察传入 Core
    core.recordEndpointObservation('browser', {
      conversation_id: 'wrong-conversation-id',
      binding_revision: 1,
      latest_completed_cursor: 'chatgpt_msg_123',
      trusted: true
    });
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.match(core.getSnapshot().endpoints.browser.unknown_reason, /attribution_mismatch/);

    // B. 过时 binding_revision 传入 Core
    core.recordEndpointObservation('browser', {
      conversation_id: targetConvId,
      binding_revision: 0, // 当前为 1
      latest_completed_cursor: 'chatgpt_msg_123',
      trusted: true
    });
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.match(core.getSnapshot().endpoints.browser.unknown_reason, /stale_revision/);
  });

  it('9. 验证 Core 与 Registry 导出的持久化快照中绝不泄露任何 ChatGPT DOM / 内部实现字段', () => {
    const registry = createProjectRegistry();
    const core = registry.registerProject({ binding: baseBinding });
    const adapter = new ChatGPTBrowserAdapter({
      executor: (script) => {
        if (script.includes('set matchCount to 0')) {
          return `SUCCESS:1:2:https://chatgpt.com/c/${targetConvId}`;
        }
        return JSON.stringify({
          isGenerating: false,
          assistantCount: 1,
          lastMessageId: 'sec-msg-id-999',
          hasValidLastMessage: true,
          isPlaceholder: false
        });
      }
    });

    core.recordEndpointObservation('browser', adapter.observeBrowserEndpoint({
      conversationId: targetConvId,
      bindingRevision: 1
    }));

    const state = core.exportState();
    const stateStr = JSON.stringify(state);

    // 保证绝不包含 DOM 专有属性或内部选择器
    assert.equal(stateStr.includes('stop-button'), false);
    assert.equal(stateStr.includes('prompt-textarea'), false);
    assert.equal(stateStr.includes('data-message-author-role'), false);
    assert.equal(stateStr.includes('windowIndex'), false);
    assert.equal(stateStr.includes('tabIndex'), false);
    // 保证游标为不透明前缀包裹
    assert.ok(state.endpoints.browser.latest_completed_cursor.startsWith('chatgpt_msg_'));
  });
});
