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
    this._stopped = false;
  }

  /**
   * 停止 Hook 入口接收，拒绝后续所有变更
   */
  stop() {
    this._stopped = true;
  }

  /**
   * 恢复 Hook 入口接收
   */
  resume() {
    this._stopped = false;
  }

  /**
   * 获取或实例化指定项目的 IDE 端点适配器
   * @param {object} params
   * @param {string} params.bindingId
   * @param {string} params.endpointId
   * @returns {AntigravityIdeAdapter}
   */
  getOrCreateAdapter({ bindingId, endpointId }) {
    const adapterKey = `${bindingId}:${endpointId}`;
    let adapter = this._ideAdapters.get(adapterKey);
    const core = this._registry.getProject(bindingId);
    const currentBinding = core.getSnapshot().binding;

    if (!adapter) {
      adapter = new AntigravityIdeAdapter({
        binding: currentBinding,
        statusCore: core,
        endpointId
      });
      this._ideAdapters.set(adapterKey, adapter);
    } else {
      adapter.updateBinding(currentBinding);
    }
    return adapter;
  }

  /**
   * 处理传入的 Antigravity Stop Hook 负载
   * @param {object} hookPayload
   * @returns {{ accepted: boolean, reason?: string, binding_id?: string, endpoint_id?: string, observation?: object }}
   */
  handleHook(hookPayload) {
    if (this._stopped) {
      return { accepted: false, reason: 'runtime_stopped' };
    }

    if (!hookPayload || typeof hookPayload !== 'object') {
      return { accepted: false, reason: 'malformed_hook_payload' };
    }

    const { conversationId } = hookPayload;
    if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
      return { accepted: false, reason: 'missing_conversation_id' };
    }

    const targetConvId = conversationId.trim();

    // 1. 在注册表中查找所有匹配该 conversation_id 的端点
    const snapshots = this._registry.listProjects();
    const matchedTargets = [];

    for (const snap of snapshots) {
      const binding = snap.binding;
      const ideList = binding?.ide_endpoints || [];
      for (const ep of ideList) {
        if (ep.conversation_id === targetConvId) {
          matchedTargets.push({
            bindingId: binding.binding_id,
            endpointId: ep.endpoint_id
          });
        }
      }
    }

    // 2. 未知或未绑定的会话：Fail-Closed 忽略
    if (matchedTargets.length === 0) {
      return {
        accepted: false,
        reason: 'unknown_conversation_not_bound',
        conversationId: targetConvId
      };
    }

    // 3. 歧义多重绑定守卫：conversationId 必须全局严格唯一映射单个端点
    if (matchedTargets.length > 1) {
      return {
        accepted: false,
        reason: 'ambiguous_conversation_multiple_bindings',
        conversationId: targetConvId
      };
    }

    // 4. 精准分发到唯一绑定的目标端点适配器
    const target = matchedTargets[0];
    const adapter = this.getOrCreateAdapter(target);
    try {
      const res = adapter.handleStopHook(hookPayload);
      return {
        accepted: Boolean(res?.accepted),
        reason: res?.reason || null,
        binding_id: target.bindingId,
        endpoint_id: target.endpointId,
        observation: res?.observation || null
      };
    } catch (err) {
      this._logger?.error?.(
        `[AntigravityHookIngress] Unexpected error handling Stop Hook for ${target.bindingId}:${target.endpointId}: ${err.message}`
      );
      return {
        accepted: false,
        reason: `internal_adapter_error: ${err.message}`,
        binding_id: target.bindingId,
        endpoint_id: target.endpointId
      };
    }
  }
}
