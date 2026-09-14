/**
 * DOM 探测器：监控 Stop 控件完整生命周期 transition 与用户交互
 */
export class DomDetector {
  constructor(store, resolver) {
    this.store = store;
    this.resolver = resolver;
    this.lastStopPresent = false;
    this.observer = null;
    this.init();
  }

  init() {
    this.bindUserInteraction();
    this.safeAttachObserver();
  }

  findStopControl() {
    return document.querySelector(
      'button[aria-label*="Stop"], button[data-testid*="stop-button"], button[data-testid*="stop"], button[aria-label*="停止"]'
    );
  }

  bindUserInteraction() {
    if (typeof window === 'undefined') return;
    window.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest(
        'button[aria-label*="Stop"], button[data-testid*="stop-button"], button[data-testid*="stop"], button[aria-label*="停止"]'
      );
      if (btn) {
        const session = this.store.getActiveSession();
        if (session && !session.terminalEmitted) {
          // 关键修复 A：仅记录观察到用户主动点击 Stop 动作，绝不在此刻直接终结！
          session.userStopActionSeen = true;
          console.debug('[DomDetector] 捕获到用户物理点击 Stop 按钮');
        }
      }
    }, true);
  }

  safeAttachObserver() {
    if (typeof document === 'undefined') return;

    const startObserving = () => {
      const target = document.documentElement || document.body;
      if (!target) {
        setTimeout(startObserving, 50);
        return;
      }

      this.observer = new MutationObserver(() => this.handleMutations());
      this.observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'disabled', 'data-testid']
      });
      // 初始扫描
      this.handleMutations();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
      if (document.documentElement) startObserving();
    } else {
      startObserving();
    }
  }

  handleMutations() {
    const session = this.store.getActiveSession();
    const hasStop = Boolean(this.findStopControl());

    if (session && !session.terminalEmitted) {
      // 关键修复 B：严格观察完整的 Stop Transition (absent -> PRESENT -> ABSENT)
      if (hasStop) {
        session.stopSeenForGeneration = true;
      } else if (!hasStop && session.stopSeenForGeneration && !session.domUiCompleted) {
        // 只有在当前代际确实曾经出现过 Stop，且现在转为消失时，才判定为 DOM UI Completed！
        session.domUiCompleted = true;
        session.domStopTimeMs = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        this.resolver.onDomUiCompleted(session);
      }
    }

    this.lastStopPresent = hasStop;
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
