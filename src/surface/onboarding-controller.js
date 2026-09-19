/**
 * 生产引导核心控制器 (Onboarding Controller)
 * 
 * 职责：
 * 1. 精确解析 ChatGPT 会话 URL 并提取 conversation ID；
 * 2. 核验唯一的真实 Browser 标签页与 Antigravity 会话元数据；
 * 3. 自动派生工作区与代码仓库身份，用户无需手填内部属性；
 * 4. 注册表唯一性校验（Display Name、Browser 会话与 IDE 会话排他）；
 * 5. 操作时实时重验（Verify → Create 两阶段防漂移）；
 * 6. 诚实确立基线（有历史事实则 latest == handled，无法确立则为 UNKNOWN）；
 * 7. 生产面向操作者的友好错误说明与操作提示。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createBinding } from '../controller/binding.js';
import {
  encodeOpaqueCursor,
  deriveProductSafeResultRef,
  parseTranscriptCompletedTurns,
  isProvenAntigravityTranscript,
  parseCanonicalRepositoryIdentity
} from '../adapters/ide/antigravity-adapter.js';
import {
  DEFAULT_AGENTAPI_BIN,
  defaultAgentApiExecutor,
  normalizeIdentityUri
} from '../adapters/production-runtime-controls.js';

/**
 * 解析完整 ChatGPT 会话 URL
 * 支持 https://chatgpt.com/c/<id>、https://chat.openai.com/c/<id>、https://chatgpt.com/g/<gpt>/c/<id>
 * @param {string} url
 * @returns {string} conversationId
 */
export function parseChatGPTConversationUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error('Invalid ChatGPT conversation URL. Please provide a full URL such as https://chatgpt.com/c/<conversation-id>');
  }

  const cleaned = url.trim();
  const pattern = /^(?:https?:\/\/(?:chatgpt\.com|chat\.openai\.com))?\/(?:g\/[^\/]+\/)?c\/([a-zA-Z0-9_-]+)(?:[?#\/]|$)/i;
  const match = cleaned.match(pattern);

  if (!match || !match[1]) {
    throw new Error('Invalid ChatGPT conversation URL. Please provide a full URL such as https://chatgpt.com/c/<conversation-id>');
  }

  return match[1];
}

/**
 * 生成系统内部唯一的 Project Binding ID
 * @param {string} [displayName]
 * @returns {string}
 */
export function generateBindingId(displayName = '') {
  const hex = crypto.randomBytes(4).toString('hex');
  const slug = String(displayName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

  return slug ? `proj-${slug}-${hex}` : `proj-${hex}`;
}

/**
 * 校验并返回待引导项目的两端身份预览 (Verify 阶段)
 */
export function verifyOnboardingIdentities({
  displayName,
  browserUrl,
  ideConversationId,
  registry,
  browserAdapter,
  agentApiBin = DEFAULT_AGENTAPI_BIN,
  agentApiExecutor = defaultAgentApiExecutor
}) {
  // 1. Display Name 校验
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    throw new Error('Project Display Name is required and must be a non-empty string.');
  }
  const cleanDisplayName = displayName.trim();

  // 排查 registry 内 display_name 冲突
  const targetLower = cleanDisplayName.toLowerCase();
  for (const proj of registry.listProjects()) {
    const existingName = (proj.binding?.display_name || proj.binding?.binding_id || '').trim().toLowerCase();
    if (existingName === targetLower) {
      throw new Error(`Project Display Name "${cleanDisplayName}" is already in use. Please choose a distinct name.`);
    }
  }

  // 2. Browser URL 与标签页核验
  const browserConvId = parseChatGPTConversationUrl(browserUrl);

  // 排查 registry 内 browser conversation 冲突
  for (const proj of registry.listProjects()) {
    if (proj.binding?.browser?.conversation_id === browserConvId) {
      const projLabel = proj.binding?.display_name || proj.binding?.binding_id;
      throw new Error(`Browser conversation "${browserConvId}" is already bound to project "${projLabel}".`);
    }
  }

  if (!browserAdapter || typeof browserAdapter.locateExactConversationTab !== 'function') {
    throw new Error('Browser adapter is not available for verifying ChatGPT conversation tab.');
  }

  let tabInfo;
  try {
    tabInfo = browserAdapter.locateExactConversationTab(browserConvId);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('No Chrome tab found')) {
      throw new Error(`No open Chrome tab found for ChatGPT conversation "${browserConvId}". Please open this conversation in Google Chrome and try again.`);
    }
    if (msg.includes('Ambiguous match')) {
      throw new Error(`Multiple Chrome tabs found for ChatGPT conversation "${browserConvId}". Please ensure only one tab is open for this conversation.`);
    }
    throw err;
  }

  // 3. IDE 会话与元数据派生
  if (!ideConversationId || typeof ideConversationId !== 'string' || !ideConversationId.trim()) {
    throw new Error('Antigravity conversation ID is required.');
  }
  const cleanIdeConvId = ideConversationId.trim();

  // 排查 registry 内 ide conversation 冲突
  for (const proj of registry.listProjects()) {
    for (const ep of proj.binding?.ide_endpoints || []) {
      if (ep.conversation_id === cleanIdeConvId) {
        const projLabel = proj.binding?.display_name || proj.binding?.binding_id;
        throw new Error(`Antigravity conversation "${cleanIdeConvId}" is already bound to project "${projLabel}".`);
      }
    }
  }

  const executor = agentApiExecutor || defaultAgentApiExecutor;
  const bin = agentApiBin || DEFAULT_AGENTAPI_BIN;

  let rawMeta;
  try {
    rawMeta = executor(bin, ['get-conversation-metadata', cleanIdeConvId]);
  } catch (err) {
    throw new Error(`Antigravity conversation "${cleanIdeConvId}" not found or inaccessible. Please check the conversation ID and ensure Antigravity is running.`);
  }

  let meta;
  try {
    meta = JSON.parse(rawMeta);
  } catch (e) {
    throw new Error(`Failed to parse Antigravity metadata for conversation "${cleanIdeConvId}": ${e.message}`);
  }

  const workspaces = meta?.response?.conversationMetadata?.metadata?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error(`Antigravity conversation "${cleanIdeConvId}" has no configured workspaces.`);
  }

  const ws = workspaces[0];
  const workspaceIdentity = normalizeIdentityUri(ws.workspaceFolderAbsoluteUri || '');
  const repositoryIdentity = ws.repository?.computedName ||
    parseCanonicalRepositoryIdentity(ws.repository?.gitOriginUrl) ||
    '';

  if (!workspaceIdentity || !repositoryIdentity) {
    throw new Error(`Antigravity conversation "${cleanIdeConvId}" workspace or repository identity could not be derived.`);
  }

  return {
    display_name: cleanDisplayName,
    browser: {
      provider: 'chatgpt',
      conversation_id: browserConvId,
      tab_url: tabInfo.url || browserUrl.trim(),
      window_index: tabInfo.windowIndex,
      tab_index: tabInfo.tabIndex
    },
    ide: {
      endpoint_id: 'ide-primary',
      conversation_id: cleanIdeConvId,
      workspace_identity: workspaceIdentity,
      repository_identity: repositoryIdentity
    }
  };
}

/**
 * 显式创建引导项目 (Create 阶段，包含实时全量重验与基线确立)
 */
export function createOnboardingProject({
  displayName,
  browserUrl,
  ideConversationId,
  registry,
  browserAdapter,
  agentApiBin = DEFAULT_AGENTAPI_BIN,
  agentApiExecutor = defaultAgentApiExecutor,
  getIdeTurns = null
}) {
  // 1. 操作时实时重验：不信任前端 Verify 缓存，两端重新完全核验
  const verified = verifyOnboardingIdentities({
    displayName,
    browserUrl,
    ideConversationId,
    registry,
    browserAdapter,
    agentApiBin,
    agentApiExecutor
  });

  const now = new Date().toISOString();

  // 2. 诚实确立 Browser 端点基线
  let browserBaselineFact = null;
  if (browserAdapter && typeof browserAdapter.observeBrowserEndpoint === 'function') {
    try {
      const obs = browserAdapter.observeBrowserEndpoint({ conversationId: verified.browser.conversation_id });
      if (obs && obs.trusted && !obs.continuity_lost) {
        browserBaselineFact = {
          endpoint: 'browser',
          role: 'browser',
          endpoint_revision: 1,
          latest_completed_cursor: obs.latest_completed_cursor || null,
          last_handled_cursor: obs.latest_completed_cursor || null,
          completed_at: obs.completed_at || now,
          latest_completed_result: obs.latest_completed_result || null,
          continuity: {
            trusted: true,
            unknown_reason: null
          },
          updated_at: now
        };
      } else {
        browserBaselineFact = {
          endpoint: 'browser',
          role: 'browser',
          endpoint_revision: 1,
          latest_completed_cursor: null,
          last_handled_cursor: null,
          completed_at: null,
          latest_completed_result: null,
          continuity: {
            trusted: false,
            unknown_reason: obs?.reason || 'onboarding_unverified_baseline'
          },
          updated_at: now
        };
      }
    } catch {
      browserBaselineFact = {
        endpoint: 'browser',
        role: 'browser',
        endpoint_revision: 1,
        latest_completed_cursor: null,
        last_handled_cursor: null,
        completed_at: null,
        latest_completed_result: null,
        continuity: {
          trusted: false,
          unknown_reason: 'onboarding_probe_failed'
        },
        updated_at: now
      };
    }
  } else {
    browserBaselineFact = {
      endpoint: 'browser',
      role: 'browser',
      endpoint_revision: 1,
      latest_completed_cursor: null,
      last_handled_cursor: null,
      completed_at: null,
      latest_completed_result: null,
      continuity: {
        trusted: false,
        unknown_reason: 'browser_adapter_not_provided'
      },
      updated_at: now
    };
  }

  // 3. 诚实确立 IDE 端点基线
  let ideTurns = null;
  if (typeof getIdeTurns === 'function') {
    ideTurns = getIdeTurns(verified.ide.conversation_id);
  } else {
    const defaultTranscriptPath = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'brain',
      verified.ide.conversation_id,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (isProvenAntigravityTranscript(defaultTranscriptPath, verified.ide.conversation_id)) {
      ideTurns = parseTranscriptCompletedTurns(defaultTranscriptPath);
    }
  }

  let ideBaselineFact = null;
  if (Array.isArray(ideTurns)) {
    if (ideTurns.length > 0) {
      const latestTurn = ideTurns[ideTurns.length - 1];
      const cursor = encodeOpaqueCursor(latestTurn.stepIndex, latestTurn.fingerprint);
      const completedAt = latestTurn.createdAt || now;
      const resultRef = deriveProductSafeResultRef('ide-primary', cursor);
      ideBaselineFact = {
        endpoint: 'ide-primary',
        role: 'ide',
        endpoint_revision: 1,
        latest_completed_cursor: cursor,
        last_handled_cursor: cursor,
        completed_at: completedAt,
        latest_completed_result: {
          cursor,
          result_ref: resultRef,
          text: latestTurn.text || '',
          captured_at: completedAt
        },
        continuity: {
          trusted: true,
          unknown_reason: null
        },
        updated_at: now
      };
    } else {
      ideBaselineFact = {
        endpoint: 'ide-primary',
        role: 'ide',
        endpoint_revision: 1,
        latest_completed_cursor: null,
        last_handled_cursor: null,
        completed_at: null,
        latest_completed_result: null,
        continuity: {
          trusted: true,
          unknown_reason: null
        },
        updated_at: now
      };
    }
  } else {
    ideBaselineFact = {
      endpoint: 'ide-primary',
      role: 'ide',
      endpoint_revision: 1,
      latest_completed_cursor: null,
      last_handled_cursor: null,
      completed_at: null,
      latest_completed_result: null,
      continuity: {
        trusted: false,
        unknown_reason: 'onboarding_transcript_unverified'
      },
      updated_at: now
    };
  }

  // 4. 组装规范 Project Binding
  const bindingId = generateBindingId(verified.display_name);
  const binding = createBinding({
    binding_id: bindingId,
    display_name: verified.display_name,
    browser: {
      provider: 'chatgpt',
      conversation_id: verified.browser.conversation_id
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: verified.ide.conversation_id,
        workspace_identity: verified.ide.workspace_identity,
        repository_identity: verified.ide.repository_identity
      }
    ]
  });

  // 5. 注册到 ProjectRegistry（同时触发现有 persistence seam 落盘）
  const core = registry.registerProject({
    binding,
    initial_endpoints: {
      browser: browserBaselineFact,
      ide_endpoints: {
        'ide-primary': ideBaselineFact
      }
    }
  });

  return {
    core,
    snapshot: core.getSnapshot()
  };
}
