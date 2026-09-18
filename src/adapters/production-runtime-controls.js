/**
 * 生产控制运行时装配模块 (Production Control Runtime Assembly)
 * 
 * 核心设计契约 (#18):
 * 1. 真实控制适配器装配：为状态表面提供生产就绪的 Browser 与多 IDE 控制适配器；
 * 2. 真实 IDE 控制能力：
 *    - 按 exact endpoint_id 精准寻址；
 *    - 核验会话、工作区与仓库身份；
 *    - 执行真正的窗口置顶聚焦 (focusWindow) 并报告凭据；
 *    - 执行受控任务派发 (dispatchControlledTask) 并严密报告阶段特异凭据；
 * 3. 单一事实来源：依赖 ProjectRegistry 作为唯一机器可读事实，绝不创建第二套状态存储；
 * 4. 共享装配缝隙：生产 runner (scripts/start-surface.mjs) 与测试共享相同的装配入口。
 */

import { execFileSync } from 'node:child_process';
import { createChatGPTBrowserAdapter } from './browser/chatgpt-browser-adapter.js';

export const DEFAULT_AGENTAPI_BIN = '/Users/yamlam/.gemini/antigravity/bin/agentapi';

/**
 * 规范化 URI/路径用于严格精确匹配
 */
export function normalizeIdentityUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  return uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
}

/**
 * 默认系统 AppleScript 执行器
 */
export function defaultSystemScriptExecutor(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

/**
 * 默认 Provider AgentAPI CLI 执行器
 */
export function defaultAgentApiExecutor(binPath, args) {
  return execFileSync(binPath, args, { encoding: 'utf8' }).trim();
}

/**
 * 生产 IDE 端点控制适配器（基于真实 AgentAPI Provider）
 */
export class ProductionIdeControlAdapter {
  constructor({
    endpointId,
    registry,
    agentApiBin = DEFAULT_AGENTAPI_BIN,
    agentApiExecutor = defaultAgentApiExecutor,
    scriptExecutor = defaultSystemScriptExecutor
  }) {
    if (!endpointId || typeof endpointId !== 'string') {
      throw new Error('endpointId is required for ProductionIdeControlAdapter');
    }
    this._endpointId = endpointId;
    this._registry = registry;
    this._agentApiBin = agentApiBin || DEFAULT_AGENTAPI_BIN;
    this._agentApiExecutor = agentApiExecutor || defaultAgentApiExecutor;
    this._scriptExecutor = scriptExecutor || defaultSystemScriptExecutor;
  }

  get endpointId() {
    return this._endpointId;
  }

  get agentApiBin() {
    return this._agentApiBin;
  }

  /**
   * 实时查询 Provider 目标端点的会话、工作区与仓库元数据并严格全等核验
   * @param {object} params
   * @param {string} params.conversationId
   * @param {string} params.expectedWorkspace
   * @param {string} params.expectedRepo
   * @returns {{ verified: true, endpointId: string, conversationId: string, workspace: string, repository: string }}
   */
  verifyTargetIdentity({ conversationId, expectedWorkspace, expectedRepo }) {
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('IDENTITY_VERIFY_FAIL: conversationId must be a non-empty string');
    }
    if (!expectedWorkspace || typeof expectedWorkspace !== 'string') {
      throw new Error(`IDENTITY_MISMATCH: Invalid or missing expectedWorkspace for endpoint "${this._endpointId}"`);
    }
    if (!expectedRepo || typeof expectedRepo !== 'string') {
      throw new Error(`IDENTITY_MISMATCH: Invalid or missing expectedRepo for endpoint "${this._endpointId}"`);
    }

    // 调用真实 Provider CLI 查询会话元数据
    const raw = this._agentApiExecutor(this._agentApiBin, ['get-conversation-metadata', conversationId]);
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch (e) {
      throw new Error(`IDENTITY_VERIFY_FAIL: Failed to parse metadata output for conversation "${conversationId}": ${e.message}`);
    }

    const workspaces = meta?.response?.conversationMetadata?.metadata?.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      throw new Error(`IDENTITY_VERIFY_FAIL: No workspaces configured for target conversation "${conversationId}"`);
    }

    const ws = workspaces[0];
    const actualWsUri = ws.workspaceFolderAbsoluteUri || '';
    const actualRepo = ws.repository?.computedName || '';

    const normActual = normalizeIdentityUri(actualWsUri);
    const normExpected = normalizeIdentityUri(expectedWorkspace);

    if (normActual !== normExpected) {
      throw new Error(
        `IDENTITY_MISMATCH: Workspace URI mismatch for ${conversationId}. Expected exact "${normExpected}", got "${normActual}"`
      );
    }

    if (actualRepo !== expectedRepo) {
      throw new Error(
        `IDENTITY_MISMATCH: Repository identity mismatch for ${conversationId}. Expected exact "${expectedRepo}", got "${actualRepo}"`
      );
    }

    return {
      verified: true,
      endpointId: this._endpointId,
      conversationId,
      workspace: normActual,
      repository: actualRepo
    };
  }

  /**
   * 执行真实的 Antigravity 窗口激活置顶，绝不吞噬执行器异常
   * @returns {{ focused: true, endpointId: string, method: string }}
   */
  focusWindow() {
    const script = `
    tell application "Antigravity"
      activate
    end tell
    `;
    this._scriptExecutor(script);
    return {
      focused: true,
      endpointId: this._endpointId,
      method: 'antigravity_activate'
    };
  }

  /**
   * 真实调用 Provider 派发受控任务
   * 成功仅能证明本地提交至 Provider CLI (SUBMITTED_LOCALLY)，绝不冒领交付
   * @param {object} params
   * @param {string} params.conversationId
   * @param {object} params.envelope
   * @param {string} params.targetEndpoint
   * @returns {{ accepted: true, taskId: string, endpointId: string, delivery_proven: false }}
   */
  dispatchControlledTask({ conversationId, envelope, targetEndpoint }) {
    if (targetEndpoint && targetEndpoint !== this._endpointId) {
      throw new Error(`DISPATCH_ENDPOINT_MISMATCH: Expected target "${this._endpointId}", got "${targetEndpoint}"`);
    }
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('DISPATCH_FAIL: Valid envelope object is required for controlled dispatch');
    }
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('DISPATCH_FAIL: conversationId is required for controlled dispatch');
    }

    const text = typeof envelope.payload?.text === 'string'
      ? envelope.payload.text
      : JSON.stringify(envelope.payload);

    const instructionText = `[Rally Controlled Instruction]
Nonce: ${envelope.nonce || ''}
Operation: ${envelope.operation || ''}
Endpoint: ${this._endpointId}

${text}`;

    // 真正调用 Provider API 进行消息派发
    this._agentApiExecutor(this._agentApiBin, [
      'send-message',
      `--title=Rally Ingress Task [${envelope.nonce || ''}]`,
      conversationId,
      instructionText
    ]);

    const taskId = envelope.nonce || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      accepted: true,
      taskId,
      endpointId: this._endpointId,
      delivery_proven: false
    };
  }
}

/**
 * 生产控制运行时装配工厂
 * @param {object} params
 * @param {object} params.registry - 规范 ProjectRegistry
 * @param {object} [params.browserOptions] - Browser 适配器配置项
 * @param {string} [params.agentApiBin] - Provider CLI 路径
 * @param {Function} [params.agentApiExecutor] - Provider 执行器
 * @param {Function} [params.scriptExecutor] - 脚本执行器
 * @returns {{ browserAdapter: object, ideAdapters: object }}
 */
export function createProductionControlRuntime({
  registry,
  browserOptions = {},
  agentApiBin = DEFAULT_AGENTAPI_BIN,
  agentApiExecutor = defaultAgentApiExecutor,
  scriptExecutor = defaultSystemScriptExecutor
}) {
  if (!registry || typeof registry.getProject !== 'function') {
    throw new Error('Valid ProjectRegistry is required for production control runtime');
  }

  const browserAdapter = createChatGPTBrowserAdapter(browserOptions);

  // 动态 IDE 适配器解析器，支持任意已注册的 exact endpoint_id
  const ideAdapters = new Proxy(new Map(), {
    get(target, prop) {
      if (prop === 'get') {
        return (endpointId) => {
          if (typeof endpointId !== 'string') return undefined;
          if (!target.has(endpointId)) {
            target.set(endpointId, new ProductionIdeControlAdapter({
              endpointId,
              registry,
              agentApiBin,
              agentApiExecutor,
              scriptExecutor
            }));
          }
          return target.get(endpointId);
        };
      }
      if (typeof prop === 'string' && prop !== 'then' && prop !== 'prototype') {
        if (!target.has(prop)) {
          target.set(prop, new ProductionIdeControlAdapter({
            endpointId: prop,
            registry,
            agentApiBin,
            agentApiExecutor,
            scriptExecutor
          }));
        }
        return target.get(prop);
      }
      return Reflect.get(target, prop);
    }
  });

  return {
    browserAdapter,
    ideAdapters
  };
}
