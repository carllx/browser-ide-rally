/**
 * 生产端点持续观察运行时协调器 (Observation Runtime Coordinator)
 * 
 * 核心架构准则 (#27):
 * 1. 统一协调端点观察生命周期，管理启动与安全关闭；
 * 2. 启动时执行一次 IDE Startup Reconciliation (One-shot)，由适配器全权负责身份与凭据校验，绝不在外部截断；
 * 3. 驱动 Browser 周期性观察，并通过变更检测守卫防止冗余写盘；
 * 4. 暴露 Antigravity Stop Hook 入口，精准分发事件到对应端点适配器；
 * 5. 纯净资源清理：在 stop 时彻底停止所有定时器，防止 open handle 泄漏。
 */

import path from 'node:path';
import os from 'node:os';
import { BrowserObservationDriver } from './browser-observation-driver.js';
import { AntigravityHookIngress } from './antigravity-hook-ingress.js';
import { resolveDefaultAntigravityTranscriptPath } from '../adapters/ide/antigravity-adapter.js';

export class ObservationRuntimeCoordinator {
  /**
   * @param {object} options
   * @param {import('../registry/project-registry.js').ProjectRegistry} options.registry - 项目注册表
   * @param {object} options.browserAdapter - ChatGPTBrowserAdapter
   * @param {number} [options.pollIntervalMs=2000] - 浏览器轮询间隔
   * @param {string} [options.brainBaseDir] - 自定义 brain 目录（用于测试隔离）
   * @param {object} [options.logger=console] - 日志记录器
   */
  constructor({
    registry,
    browserAdapter,
    pollIntervalMs = 2000,
    brainBaseDir = null,
    logger = console
  }) {
    if (!registry || typeof registry.listProjects !== 'function') {
      throw new Error('Valid ProjectRegistry is required for ObservationRuntimeCoordinator');
    }

    this._registry = registry;
    this._brainBaseDir = brainBaseDir;
    this._logger = logger;

    this._hookIngress = new AntigravityHookIngress({
      registry,
      logger
    });

    this._browserDriver = new BrowserObservationDriver({
      registry,
      browserAdapter,
      pollIntervalMs,
      logger
    });
  }

  get browserDriver() {
    return this._browserDriver;
  }

  get hookIngress() {
    return this._hookIngress;
  }

  /**
   * 处理 Antigravity Stop Hook 事件
   * @param {object} hookPayload
   */
  handleAntigravityHook(hookPayload) {
    return this._hookIngress.handleHook(hookPayload);
  }

  /**
   * 启动时对所有已注册项目的 IDE 端点执行一次性状态恢复核验 (One-shot)
   * 遵循单一职责契约：不越权在外层检查 transcript 存在性，全部交付适配器进行正规核验与 fail-closed
   * @param {object} [options]
   * @param {string} [options.brainBaseDir]
   * @returns {{ reconciledCount: number, errorCount: number }}
   */
  reconcileAllIdeEndpointsOnStartup({ brainBaseDir = null } = {}) {
    const snapshots = this._registry.listProjects();
    const stats = { reconciledCount: 0, errorCount: 0 };
    const effectiveBaseDir = brainBaseDir || this._brainBaseDir;

    for (const snap of snapshots) {
      const binding = snap.binding;
      const bindingId = binding?.binding_id;
      const ideEndpoints = binding?.ide_endpoints || [];

      if (!bindingId || ideEndpoints.length === 0) {
        continue;
      }

      for (const ideEp of ideEndpoints) {
        const convId = ideEp.conversation_id;
        const endpointId = ideEp.endpoint_id;
        if (!convId || !endpointId) {
          continue;
        }

        const transcriptPath = resolveDefaultAntigravityTranscriptPath(convId, effectiveBaseDir);

        try {
          const adapter = this._hookIngress.getOrCreateAdapter({ bindingId, endpointId });

          adapter.reconcileOnStartup({
            transcriptPath,
            conversationId: convId,
            workspacePaths: [ideEp.workspace_identity]
          });
          stats.reconciledCount++;
        } catch (err) {
          stats.errorCount++;
          this._logger?.warn?.(
            `[ObservationRuntimeCoordinator] Failed to reconcile IDE endpoint "${endpointId}" for project "${bindingId}": ${err.message}`
          );
        }
      }
    }

    return stats;
  }

  /**
   * 启动持续观察运行时
   */
  async start() {
    this._logger?.log?.('[ObservationRuntimeCoordinator] Starting observation runtime...');
    // 1. 启动时执行一次 IDE 端点核验
    this.reconcileAllIdeEndpointsOnStartup();

    // 2. 启动浏览器端点周期轮询驱动器
    this._browserDriver.start();
  }

  /**
   * 停止持续观察运行时
   */
  stop() {
    this._logger?.log?.('[ObservationRuntimeCoordinator] Stopping observation runtime...');
    this._browserDriver.stop();
  }
}

/**
 * 工厂函数：创建生产端点观察运行时协调器
 */
export function createObservationRuntimeCoordinator(options) {
  return new ObservationRuntimeCoordinator(options);
}
