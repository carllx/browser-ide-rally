import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import {
  parseChatGPTConversationUrl,
  generateBindingId,
  verifyOnboardingIdentities,
  createOnboardingProject
} from '../../src/surface/onboarding-controller.js';

// Mock Browser Adapter 工厂
function createMockBrowserAdapter({
  tabs = [],
  probeResult = null
} = {}) {
  return {
    locateExactConversationTab(convId) {
      const matches = tabs.filter(t => t.conversationId === convId);
      if (matches.length === 0) {
        throw new Error(`TARGET_LOOKUP_FAIL: No Chrome tab found matching conversation "${convId}"`);
      }
      if (matches.length > 1) {
        throw new Error(`TARGET_LOOKUP_FAIL: Ambiguous match: ${matches.length} tabs match conversation "${convId}"`);
      }
      return {
        windowIndex: matches[0].windowIndex || 1,
        tabIndex: matches[0].tabIndex || 1,
        url: matches[0].url || `https://chatgpt.com/c/${convId}`
      };
    },
    observeBrowserEndpoint({ conversationId } = {}) {
      if (probeResult) {
        return probeResult(conversationId);
      }
      return {
        trusted: false,
        continuity_lost: true,
        reason: 'unobserved_mock'
      };
    }
  };
}

// Mock AgentAPI Provider CLI 执行器
function createMockAgentApiExecutor(metadataMap = {}) {
  return function agentApiExecutor(binPath, args) {
    const cmd = args[0];
    const convId = args[1];
    if (cmd === 'get-conversation-metadata') {
      if (!metadataMap[convId]) {
        throw new Error(`Conversation "${convId}" not found`);
      }
      return JSON.stringify(metadataMap[convId]);
    }
    throw new Error(`Unsupported mock command: ${cmd}`);
  };
}

test('[Onboarding Controller] 1. URL 解析：准确解析标准/GPTs/带参数的 ChatGPT URL，严格拦截非法形状', () => {
  // 标准 ChatGPT URL
  assert.equal(
    parseChatGPTConversationUrl('https://chatgpt.com/c/6774a3f1-0001-4000-8000-000000000001'),
    '6774a3f1-0001-4000-8000-000000000001'
  );

  // 旧域名 chat.openai.com
  assert.equal(
    parseChatGPTConversationUrl('https://chat.openai.com/c/conv-classic-123'),
    'conv-classic-123'
  );

  // GPT 路径 URL /g/<gptId>/c/<convId>
  assert.equal(
    parseChatGPTConversationUrl('https://chatgpt.com/g/g-2DQzUNuik-code-copilot/c/conv-custom-gpt-456'),
    'conv-custom-gpt-456'
  );

  // 附带查询参数和锚点
  assert.equal(
    parseChatGPTConversationUrl('https://chatgpt.com/c/conv-params-789?model=gpt-4o#bottom'),
    'conv-params-789'
  );

  // 非法或缺少会话 ID 的 URL
  assert.throws(() => {
    parseChatGPTConversationUrl('https://google.com/search?q=chatgpt');
  }, /Invalid ChatGPT conversation URL/i);

  assert.throws(() => {
    parseChatGPTConversationUrl('https://chatgpt.com/');
  }, /Invalid ChatGPT conversation URL/i);

  assert.throws(() => {
    parseChatGPTConversationUrl('/c/conv-relative-path-123');
  }, /Invalid ChatGPT conversation URL/i);

  assert.throws(() => {
    parseChatGPTConversationUrl('conv-plain-id-only');
  }, /Invalid ChatGPT conversation URL/i);

  assert.throws(() => {
    parseChatGPTConversationUrl('');
  }, /Invalid ChatGPT conversation URL/i);
});

test('[Onboarding Controller] 2. 身份验证：成功验证 Browser 与 IDE 身份，自动派生 workspace 与 repository', () => {
  const registry = createProjectRegistry();
  const mockBrowser = createMockBrowserAdapter({
    tabs: [{ conversationId: 'conv-browser-valid', url: 'https://chatgpt.com/c/conv-browser-valid' }]
  });
  const mockAgentApi = createMockAgentApiExecutor({
    'conv-ide-valid': {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///Users/developer/code/browser-ide-rally',
                repository: {
                  computedName: 'carllx/browser-ide-rally'
                }
              }
            ]
          }
        }
      }
    }
  });

  const verified = verifyOnboardingIdentities({
    displayName: 'My Verified Project',
    browserUrl: 'https://chatgpt.com/c/conv-browser-valid',
    ideConversationId: 'conv-ide-valid',
    registry,
    browserAdapter: mockBrowser,
    agentApiExecutor: mockAgentApi
  });

  assert.equal(verified.display_name, 'My Verified Project');
  assert.equal(verified.browser.conversation_id, 'conv-browser-valid');
  assert.equal(verified.browser.tab_url, 'https://chatgpt.com/c/conv-browser-valid');
  assert.equal(verified.ide.conversation_id, 'conv-ide-valid');
  assert.equal(verified.ide.workspace_identity, '/Users/developer/code/browser-ide-rally');
  assert.equal(verified.ide.repository_identity, 'carllx/browser-ide-rally');
});

test('[Onboarding Controller] 3. 负向拦截：标签页缺失、模糊多匹配或 IDE 会话不存在时抛出可操作错误', () => {
  const registry = createProjectRegistry();

  // 1. Browser 0 匹配
  const mockBrowserEmpty = createMockBrowserAdapter({ tabs: [] });
  assert.throws(() => {
    verifyOnboardingIdentities({
      displayName: 'Proj',
      browserUrl: 'https://chatgpt.com/c/conv-missing',
      ideConversationId: 'conv-ide',
      registry,
      browserAdapter: mockBrowserEmpty,
      agentApiExecutor: () => {}
    });
  }, /No open Chrome tab found/i);

  // 2. Browser 多匹配歧义
  const mockBrowserAmbiguous = createMockBrowserAdapter({
    tabs: [
      { conversationId: 'conv-dup' },
      { conversationId: 'conv-dup' }
    ]
  });
  assert.throws(() => {
    verifyOnboardingIdentities({
      displayName: 'Proj',
      browserUrl: 'https://chatgpt.com/c/conv-dup',
      ideConversationId: 'conv-ide',
      registry,
      browserAdapter: mockBrowserAmbiguous,
      agentApiExecutor: () => {}
    });
  }, /Multiple Chrome tabs found/i);

  // 3. IDE 会话不存在
  const mockBrowserOk = createMockBrowserAdapter({
    tabs: [{ conversationId: 'conv-browser-1' }]
  });
  const mockAgentApiMissing = createMockAgentApiExecutor({});
  assert.throws(() => {
    verifyOnboardingIdentities({
      displayName: 'Proj',
      browserUrl: 'https://chatgpt.com/c/conv-browser-1',
      ideConversationId: 'conv-ide-missing',
      registry,
      browserAdapter: mockBrowserOk,
      agentApiExecutor: mockAgentApiMissing
    });
  }, /Antigravity conversation "conv-ide-missing" not found/i);
});

test('[Onboarding Controller] 4. 项目创建：确立历史基线（latest_completed == last_handled），结果状态为 NO_NEW_RESULT', () => {
  const registry = createProjectRegistry();
  const mockBrowser = createMockBrowserAdapter({
    tabs: [{ conversationId: 'conv-browser-base' }],
    probeResult: (convId) => ({
      trusted: true,
      latest_completed_cursor: 'chatgpt_msg_turn_10',
      completed_at: new Date().toISOString(),
      latest_completed_result: {
        cursor: 'chatgpt_msg_turn_10',
        result_ref: 'res_browser_turn_10',
        text: 'Previous ChatGPT reply',
        captured_at: new Date().toISOString()
      }
    })
  });

  const mockAgentApi = createMockAgentApiExecutor({
    'conv-ide-base': {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: '/Users/test/workspace',
                repository: { computedName: 'owner/repo' }
              }
            ]
          }
        }
      }
    }
  });

  // 注入已完成 turns 的 IDE 解析函数
  const mockGetIdeTurns = () => [
    { stepIndex: 5, fingerprint: 'fp123', text: 'Previous IDE task done' }
  ];

  const { snapshot, core } = createOnboardingProject({
    displayName: 'Baseline Project',
    browserUrl: 'https://chatgpt.com/c/conv-browser-base',
    ideConversationId: 'conv-ide-base',
    registry,
    browserAdapter: mockBrowser,
    agentApiExecutor: mockAgentApi,
    getIdeTurns: mockGetIdeTurns
  });

  assert.equal(snapshot.binding.display_name, 'Baseline Project');
  // 确认两端点被确立为基线，状态均为 NO_NEW_RESULT，绝不冒领 NEW 积压
  assert.equal(snapshot.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(snapshot.endpoints.browser.latest_completed_cursor, 'chatgpt_msg_turn_10');
  assert.equal(snapshot.endpoints.browser.last_handled_cursor, 'chatgpt_msg_turn_10');

  const ideSlot = snapshot.endpoints.ide_endpoints['ide-primary'];
  assert.equal(ideSlot.result_state, 'NO_NEW_RESULT');
  assert.equal(ideSlot.latest_completed_cursor, 'ag-step:5:fp123');
  assert.equal(ideSlot.last_handled_cursor, 'ag-step:5:fp123');
});

test('[Onboarding Controller] 5. 诚实未知：若端点结果事实无法确立，创建成功且保持诚实 UNKNOWN 状态', () => {
  const registry = createProjectRegistry();
  const mockBrowser = createMockBrowserAdapter({
    tabs: [{ conversationId: 'conv-browser-unk' }],
    // Browser 探测无法确立受信完成
    probeResult: () => ({
      trusted: false,
      continuity_lost: true,
      reason: 'unverified_probe_status'
    })
  });

  const mockAgentApi = createMockAgentApiExecutor({
    'conv-ide-unk': {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: '/Users/test/workspace',
                repository: { computedName: 'owner/repo' }
              }
            ]
          }
        }
      }
    }
  });

  // IDE 无法获取有效 transcript
  const mockGetIdeTurnsUnk = () => null;

  const { snapshot } = createOnboardingProject({
    displayName: 'Uncertain Project',
    browserUrl: 'https://chatgpt.com/c/conv-browser-unk',
    ideConversationId: 'conv-ide-unk',
    registry,
    browserAdapter: mockBrowser,
    agentApiExecutor: mockAgentApi,
    getIdeTurns: mockGetIdeTurnsUnk
  });

  // 验证诚实输出 UNKNOWN，不伪造 NO_NEW_RESULT
  assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].result_state, 'UNKNOWN');
  assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].continuity.trusted, false);
  assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].continuity.unknown_reason, 'onboarding_transcript_unverified');

  // 变体测试：transcript 存在但 0 条 completed turns，必须诚实保持 UNKNOWN，严禁伪造 trusted NO_NEW_RESULT
  const mockGetIdeTurnsZero = () => [];
  const { snapshot: snapZero } = createOnboardingProject({
    displayName: 'Zero Turns Project',
    browserUrl: 'https://chatgpt.com/c/conv-browser-unk-2',
    ideConversationId: 'conv-ide-unk-2',
    registry: createProjectRegistry(),
    browserAdapter: createMockBrowserAdapter({
      tabs: [{ conversationId: 'conv-browser-unk-2' }],
      probeResult: () => ({ trusted: true, latest_completed_cursor: null })
    }),
    agentApiExecutor: createMockAgentApiExecutor({
      'conv-ide-unk-2': {
        response: {
          conversationMetadata: {
            metadata: {
              workspaces: [{ workspaceFolderAbsoluteUri: '/Users/test/workspace', repository: { computedName: 'owner/repo' } }]
            }
          }
        }
      }
    }),
    getIdeTurns: mockGetIdeTurnsZero
  });

  const zeroSlot = snapZero.endpoints.ide_endpoints['ide-primary'];
  assert.equal(zeroSlot.result_state, 'UNKNOWN');
  assert.equal(zeroSlot.continuity.trusted, false);
  assert.equal(zeroSlot.continuity.unknown_reason, 'no_completed_turns_found');
});

test('[Onboarding Controller] 6. 操作时重验 (Create-time revalidation)：Verify 与 Create 之间标签页若关闭，Create 阶段 Fail-Closed', () => {
  const registry = createProjectRegistry();
  let tabOpen = true;
  const mockBrowser = {
    locateExactConversationTab(convId) {
      if (!tabOpen) {
        throw new Error(`TARGET_LOOKUP_FAIL: No Chrome tab found matching conversation "${convId}"`);
      }
      return { windowIndex: 1, tabIndex: 1, url: `https://chatgpt.com/c/${convId}` };
    },
    observeBrowserEndpoint: () => ({ trusted: true, latest_completed_cursor: null })
  };

  const mockAgentApi = createMockAgentApiExecutor({
    'conv-ide-race': {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [{ workspaceFolderAbsoluteUri: '/ws', repository: { computedName: 'o/r' } }]
          }
        }
      }
    }
  });

  // 第一步：Verify 正常
  const verified = verifyOnboardingIdentities({
    displayName: 'Race Project',
    browserUrl: 'https://chatgpt.com/c/conv-race',
    ideConversationId: 'conv-ide-race',
    registry,
    browserAdapter: mockBrowser,
    agentApiExecutor: mockAgentApi
  });
  assert.equal(verified.browser.conversation_id, 'conv-race');

  // 模拟在点击 Create 之前用户关闭了浏览器标签页
  tabOpen = false;

  // 第二步：Create 必须重新核验并 Fail-Closed
  assert.throws(() => {
    createOnboardingProject({
      displayName: 'Race Project',
      browserUrl: 'https://chatgpt.com/c/conv-race',
      ideConversationId: 'conv-ide-race',
      registry,
      browserAdapter: mockBrowser,
      agentApiExecutor: mockAgentApi
    });
  }, /No open Chrome tab found/i);
});
