/**
 * Antigravity Stop Hook 事件入口与分发模块 (Antigravity Hook Ingress)
 * 
 * 核心设计准则 (#27):
 * 1. 严格基于事件驱动：仅在接收到 Antigravity 官方 Stop Hook 事件时触发消费，严禁后台轮询；
 * 2. 精准路由分发：路由键严格为 conversationId -> binding_id -> endpoint_id；
 * 3. 严格隔离与 Fail-Closed：未绑定会话必须 fail-closed / ignore，绝不误伤或串入其他项目；
 * 4. 委托既有适配器契约：绝不在适配器外重复解析 workspace/repo、transcript provenance 或 fingerprint，
 *    全部无损委托给已在 #16 经过严密合约测试的 AntigravityIdeAdapter.handleStopHook(payload)。
 */

import { AntigravityIdeAdapter } from '../adapters/ide/antigravity-adapter.js';

export class AntigravityHookIngress {
  /**
   * @param {object} options
   * @param {import('../registry/project-registry.js').ProjectRegistry} options.registry - 项目注册表
   * @param {Map<string, AntigravityIdeAdapter>} [options.ideAdapters] - 可选的适配器缓存映射
   * @param {object} [options.logger=console] - 日志记录器
   */
  constructor({ registry, ideAdapters = null, logger = console }) {
    if (!registry || typeof registry.listProjects !== 'function') {
      throw new Error('Valid ProjectRegistry is required for AntigravityHookIngress');
    }

    this._registry = registry;
    this._ideAdapters = ideAdapters instanceof Map ? ideAdapters : new Map();
    this._logger = logger;
  }

  /**
   * 处理传入的 Antigravity Stop Hook 负载
   * @param {object} hookPayload
   * @returns {{ accepted: boolean, reason?: string, binding_id?: string, endpoint_id?: string, observation?: object }}
   */
  handleHook(hookPayload) {
    if (!hookPayload || typeof hookPayload !== 'object') {
      return { accepted: false, reason: 'malformed_hook_payload' };
    }

    const { conversationId } = hookPayload;
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      return { accepted: false, reason: 'missing_conversation_id' };
    }

    const targetConvId = conversationId.trim();

    // 1. 在注册表中查找精确包含该 conversation_id 的项目与 IDE 端点
    const snapshots = this._registry.listProjects();
    let targetBindingId = null;
    let targetEndpointId = null;

    for (const snap of snapshots) {
      const binding = snap.binding;
      const ideList = binding?.ide_endpoints || [];
      const matched = ideList.find(ep => ep.conversation_id === targetConvId);
      if (matched) {
        targetBindingId = binding.binding_id;
        targetEndpointId = matched.endpoint_id;
        break;
      }
    }

    // 2. 未知或未绑定的会话：Fail-Closed 忽略
    if (!targetBindingId || !targetEndpointId) {
      return {
        accepted: false,
        reason: 'unknown_conversation_not_bound',
        conversationId: targetConvId
      };
    }

    // 3. 获取或构建对应端点的 AntigravityIdeAdapter 实例
    const adapterKey = `${targetBindingId}:${targetEndpointId}`;
    let adapter = this._ideAdapters.get(adapterKey);
    const core = this._registry.getProject(targetBindingId);
    const currentBinding = core.getSnapshot().binding;

    if (!adapter) {
      adapter = new AntigravityIdeAdapter({
        binding: currentBinding,
        statusCore: core,
        endpointId: targetEndpointId
      });
      this._ideAdapters.set(adapterKey, adapter);
    } else {
      // 保证 binding 版本与拓扑同步
      adapter.updateBinding(currentBinding);
    }

    // 4. 委托给 AntigravityIdeAdapter.handleStopHook 执行严密校验与 Core 录入
    try {
      const res = adapter.handleStopHook(hookPayload);
      return {
        accepted: Boolean(res?.accepted),
        reason: res?.reason || null,
        binding_id: targetBindingId,
        endpoint_id: targetEndpointId,
        observation: res?.observation || null
      };
    } catch (err) {
      this._logger?.error?.(
        `[AntigravityHookIngress] Unexpected error handling Stop Hook for ${adapterKey}: ${err.message}`
      );
      return {
        accepted: false,
        reason: `internal_adapter_error: ${err.message}`,
        binding_id: targetBindingId,
        endpoint_id: targetEndpointId
      };
    }
  }
}
