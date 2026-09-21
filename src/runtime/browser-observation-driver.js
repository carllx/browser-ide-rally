/**
 * 浏览器端点观察驱动器 (Browser Observation Driver)
 * 
 * 核心设计准则 (#27):
 * 1. 有界周期轮询：定期调用 ChatGPTBrowserAdapter.observeBrowserEndpoint 获取最新 DOM 观察；
 * 2. 变更感知防重写 (Change-Detection Guard)：
 *    - 若 is_generating === true 或 should_record === false，严禁录入 Core；
 *    - 若 latest cursor 与 trusted 状态相同，跳过 recordEndpointObservation(...)；
 *    - 杜绝每个轮询周期无脑 recordEndpointObservation 触发 durable registry 无限重写磁盘！
 * 3. 隔离与容错：单项目观察失败或标签页未打开绝不阻塞其他项目的观察与运行时稳定性。
 */

/**
 * 校验最新观察事实相比当前快照是否无实质变更
 * @param {object} currentBrowserSnapshot
 * @param {object} newObservation
 * @returns {boolean}
 */
export function isObservationUnchanged(currentBrowserSnapshot, newObservation) {
  if (!currentBrowserSnapshot || !newObservation) return false;

  const currentTrusted = Boolean(currentBrowserSnapshot.continuity?.trusted);
  const nextTrusted = Boolean(newObservation.trusted);

  // 1. 若当前未受信且新观察也未受信：
  // 端点处于 UNKNOWN 状态且未恢复受信任，若未受信原因相同，跳过重复写盘；防止断开连接或找不到标签页时持续无限重写
  if (!currentTrusted && !nextTrusted) {
    const currentReason = currentBrowserSnapshot.continuity?.unknown_reason ?? null;
    const rawReason = newObservation.reason ?? newObservation.error ?? (newObservation.continuity_lost ? 'continuity_lost' : null);
    const nextReason = rawReason ?? (currentReason || 'observation_untrusted');
    return currentReason === nextReason;
  }

  // 2. 受信任状态发生跃迁 (true <-> false)：必须录入 Core
  if (currentTrusted !== nextTrusted) return false;

  // 3. 两者均受信任：比较最新完成游标
  const currentCursor = currentBrowserSnapshot.latest_completed_cursor ?? null;
  const nextCursor = newObservation.latest_completed_cursor ?? null;
  return currentCursor === nextCursor;
}

export class BrowserObservationDriver {
  /**
   * @param {object} options
   * @param {import('../registry/project-registry.js').ProjectRegistry} options.registry - 项目注册表
   * @param {object} options.browserAdapter - ChatGPTBrowserAdapter 实例
   * @param {number} [options.pollIntervalMs=2000] - 轮询间隔 (毫秒)
   * @param {object} [options.logger=console] - 日志记录器
   */
  constructor({ registry, browserAdapter, pollIntervalMs = 2000, timeoutMs = 3000, logger = console }) {
    if (!registry || typeof registry.listProjects !== 'function') {
      throw new Error('Valid ProjectRegistry is required for BrowserObservationDriver');
    }
    if (!browserAdapter || (typeof browserAdapter.observeBrowserEndpoint !== 'function' && typeof browserAdapter.observeBrowserEndpointAsync !== 'function')) {
      throw new Error('Valid browserAdapter with observeBrowserEndpoint is required for BrowserObservationDriver');
    }

    this._registry = registry;
    this._browserAdapter = browserAdapter;
    this._pollIntervalMs = Math.max(100, pollIntervalMs);
    this._timeoutMs = Math.max(100, timeoutMs);
    this._logger = logger;
    this._timer = null;
    this._isPolling = false;
    this._started = false;
    this._stopped = false;
    this._witnessState = new Map();
  }

  /**
   * 启动后台观察轮询
   */
  start() {
    this._started = true;
    this._stopped = false;
    if (this._timer) {
      return;
    }
    this._scheduleNextPoll();
  }

  /**
   * 停止后台观察轮询并清理定时器
   */
  stop() {
    this._started = false;
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._witnessState.clear();
  }

  /**
   * 当前是否处于运行中状态
   * @returns {boolean}
   */
  isRunning() {
    return this._started && !this._stopped;
  }

  /**
   * 获取指定项目的当前 witness 状态 (用于观测诊断与测试)
   * @param {string} bindingId
   * @returns {{ stage: 'generating' | 'idle', pending?: boolean }}
   */
  getWitnessState(bindingId) {
    const state = this._witnessState.get(bindingId);
    if (!state) return { stage: 'idle' };
    return { ...state };
  }

  /**
   * 调度下一轮轮询
   * @private
   */
  _scheduleNextPoll() {
    if (this._stopped) return;
    this._timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        this._logger?.error?.(`[BrowserObservationDriver] Unhandled error during poll: ${err.message}`);
      } finally {
        if (!this._stopped) {
          this._scheduleNextPoll();
        }
      }
    }, this._pollIntervalMs);
  }

  /**
   * 执行单次全量已绑定浏览器端点观察
   * @returns {Promise<{ recordedCount: number, skippedCount: number, generatingCount: number, errorCount: number }>}
   */
  async pollOnce() {
    if (this._stopped || this._isPolling) {
      return { recordedCount: 0, skippedCount: 0, generatingCount: 0, errorCount: 0 };
    }

    this._isPolling = true;
    const stats = {
      recordedCount: 0,
      skippedCount: 0,
      generatingCount: 0,
      errorCount: 0
    };

    try {
      const snapshots = this._registry.listProjects();

      for (const snapshot of snapshots) {
        if (this._stopped) {
          break;
        }
        const binding = snapshot.binding;
        const bindingId = binding?.binding_id;
        const browser = binding?.browser;
        const conversationId = browser?.conversation_id;

        if (!bindingId || !conversationId) {
          continue;
        }

        try {
          let observation;
          if (typeof this._browserAdapter.observeBrowserEndpointAsync === 'function') {
            observation = await this._browserAdapter.observeBrowserEndpointAsync({
              conversationId,
              bindingRevision: binding.binding_revision,
              timeoutMs: this._timeoutMs
            });
          } else {
            observation = this._browserAdapter.observeBrowserEndpoint({
              conversationId,
              bindingRevision: binding.binding_revision
            });
          }

          if (this._stopped) break;

          // Witness 状态机维护 (Delta 4 & Delta 5)
          // 若发生超时、连续性丢失或异常未受信，重置该项目的 pending witness
          if (observation.timed_out === true || observation.continuity_lost === true || (!observation.trusted && !observation.is_generating)) {
            this._witnessState.delete(bindingId);
          }

          // 1. 正在生成中：记录 pending witness，不录入 Core
          if (observation.is_generating === true) {
            this._witnessState.set(bindingId, {
              pending: true,
              stage: 'generating',
              conversationId,
              revision: binding.binding_revision
            });
            stats.generatingCount++;
            continue;
          }

          // 超时或其他明确指示不可录入的非突变瞬态：直接跳过 Core 录入
          if (observation.should_record === false) {
            continue;
          }

          // 2. 检查是否满足 live witnessed 闭环
          const currentBrowser = snapshot.endpoints?.browser || {};
          const currentCursor = currentBrowser.latest_completed_cursor ?? null;
          const nextCursor = observation.latest_completed_cursor ?? null;
          const isNewCursor = nextCursor !== currentCursor;

          const witness = this._witnessState.get(bindingId);
          let isLiveWitnessed = false;
          if (witness && witness.pending && witness.conversationId === conversationId && witness.revision === binding.binding_revision && isNewCursor) {
            isLiveWitnessed = true;
            this._witnessState.delete(bindingId);
          } else {
            this._witnessState.delete(bindingId);
          }
          observation.live_witnessed = isLiveWitnessed;

          // 3. 变更感知防重写比对 (Change Detection Guard)
          if (isObservationUnchanged(currentBrowser, observation)) {
            stats.skippedCount++;
            continue;
          }

          // 4. 录入 Core
          const core = this._registry.getProject(bindingId);
          core.recordEndpointObservation('browser', observation);
          stats.recordedCount++;
        } catch (err) {
          stats.errorCount++;
          this._logger?.warn?.(
            `[BrowserObservationDriver] Failed to observe project "${bindingId}" (${conversationId}): ${err.message}`
          );
        }
      }
    } finally {
      this._isPolling = false;
    }

    return stats;
  }
}
