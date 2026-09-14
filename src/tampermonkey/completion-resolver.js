/**
 * 双探测器完成仲裁器 (Completion Resolver)
 */
import { EVENTS, CONFIDENCE, CONFIG } from './constants.js';

export class CompletionResolver {
  constructor(eventBus, store, metrics) {
    this.eventBus = eventBus;
    this.store = store;
    this.metrics = metrics;
  }

  onNetworkStarted(session) {
    if (session && !session.startedEmitted) {
      session.startedEmitted = true;
      this.eventBus.publish(EVENTS.STARTED, session, ['network'], CONFIDENCE.CONFIRMED, 'primary_stream_active');
    }
  }

  onNetworkDone(session) {
    if (!session || session.terminalEmitted) return;
    session.networkDone = true;

    // 关键修复 A：如果之前用户点过 Stop，但最终依然收到了正常的 [DONE]，Normal Completion 获胜！
    this.evaluateCompletion(session, 'network_done');
  }

  onDomUiCompleted(session) {
    if (!session) return;

    // 关键修复 C：晚到 DOM 证据安全升级处理
    if (session.terminalEmitted) {
      const upgraded = session.upgradeEvidenceToConfirmed();
      if (upgraded) {
        // 仅在内部指标/证据状态升级，坚决不发射第二次公开 response.completed 事件！
        this.metrics.recordTimingDiff(session);
        console.debug('[Resolver] 晚到 DOM 到达：证据静默升级为 confirmed，不重发公开事件');
      }
      return;
    }

    this.evaluateCompletion(session, 'dom_ui_completed');
  }

  evaluateCompletion(session, trigger) {
    if (!session || session.terminalEmitted) return;

    // 黄金路径：Network [DONE] 与 DOM Stop 消失双对齐
    if (session.networkDone && session.domUiCompleted) {
      if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = null;
      }
      session.markTerminalEmitted(EVENTS.COMPLETED, CONFIDENCE.CONFIRMED);
      this.metrics.recordTimingDiff(session);
      this.eventBus.publish(EVENTS.COMPLETED, session, ['network', 'dom'], CONFIDENCE.CONFIRMED, 'dual_signals_aligned');
      this.store.clearActiveSession(session);
      return;
    }

    // Network [DONE] 先到 -> 开启 400ms 宽限窗口等待 DOM
    if (session.networkDone && !session.domUiCompleted) {
      if (!session.graceTimer) {
        session.graceTimer = setTimeout(() => {
          if (!session.terminalEmitted) {
            session.markTerminalEmitted(EVENTS.COMPLETED, CONFIDENCE.NETWORK_ONLY);
            this.eventBus.publish(EVENTS.COMPLETED, session, ['network'], CONFIDENCE.NETWORK_ONLY, 'grace_window_timeout_fallback', {
              dom_confirmation_missing: true
            });
            // 不立即清理 activeSession，给后续晚到 DOM 一次静默升级证据的机会
          }
        }, CONFIG.GRACE_WINDOW_MS);
      }
      return;
    }

    // DOM 先到 -> 等待 Network [DONE]
    if (session.domUiCompleted && !session.networkDone) {
      if (!session.graceTimer) {
        session.graceTimer = setTimeout(() => {
          if (!session.terminalEmitted) {
            session.markTerminalEmitted(EVENTS.COMPLETED, CONFIDENCE.DOM_ONLY);
            this.eventBus.publish(EVENTS.COMPLETED, session, ['dom'], CONFIDENCE.DOM_ONLY, 'network_done_timeout_fallback', {
              network_hook_missing: true
            });
            this.store.clearActiveSession(session);
          }
        }, CONFIG.GRACE_WINDOW_MS);
      }
      return;
    }
  }

  onStreamClosedWithoutDone(session, error = null) {
    if (!session || session.terminalEmitted) return;

    // 关键修复 A：流关闭且没有 [DONE] 时，若捕获到用户曾点击 Stop，确立为 stopped_by_user
    if (session.userStopActionSeen) {
      session.markTerminalEmitted(EVENTS.STOPPED_BY_USER, CONFIDENCE.CONFIRMED);
      this.eventBus.publish(EVENTS.STOPPED_BY_USER, session, ['dom', 'network'], CONFIDENCE.CONFIRMED, 'user_clicked_stop_and_stream_aborted');
      this.store.clearActiveSession(session);
      return;
    }

    // 关键修复 G：真正属于 Primary Generation 的异常中断（且非用户主动终止）
    const reason = error ? `stream_error: ${error.message || error}` : 'primary_stream_closed_without_done';
    session.markTerminalEmitted(EVENTS.INTERRUPTED, CONFIDENCE.CONFIRMED);
    this.eventBus.publish(EVENTS.INTERRUPTED, session, ['network'], CONFIDENCE.CONFIRMED, reason);
    this.store.clearActiveSession(session);
  }
}
