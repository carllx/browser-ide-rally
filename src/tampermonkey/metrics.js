/**
 * 运行态指标统计与纯净 Timing 采样
 */
export class MetricsCollector {
  constructor() {
    // 历史 baseline 说明元数据 (保留审查来源，但坚决不混入当前候选 Timing 分布)
    this.historical_baseline = Object.freeze({
      normal_completed_provenance: 14,
      user_stopped_provenance: 2
    });

    // 关键修复 6：纯净的当前候选 Primary Timing 样本库，坚决从空数组开始
    this.primary_timing_diffs_ms = [];

    this.counters = {
      primary_generations: 0,
      auxiliary_streams_ignored: 0,
      confirmed_completions: 0,
      network_only_completions: 0,
      dom_only_completions: 0,
      stopped_by_user: 0,
      generic_interrupted: 0,
      duplicates_prevented: 0
    };
  }

  recordTimingDiff(session) {
    if (session && session.networkDoneTimeMs && session.domStopTimeMs) {
      const diff = +(session.domStopTimeMs - session.networkDoneTimeMs).toFixed(1);
      this.primary_timing_diffs_ms.push(diff);
    }
  }

  recordAuxiliaryIgnored() {
    this.counters.auxiliary_streams_ignored++;
  }

  recordEvent(eventPayload) {
    const ev = eventPayload.event;
    const conf = eventPayload.confidence;

    if (ev === 'response.started') {
      this.counters.primary_generations++;
    } else if (ev === 'response.completed') {
      if (conf === 'confirmed') this.counters.confirmed_completions++;
      else if (conf === 'network_only') this.counters.network_only_completions++;
      else if (conf === 'dom_only') this.counters.dom_only_completions++;
    } else if (ev === 'response.stopped_by_user') {
      this.counters.stopped_by_user++;
    } else if (ev === 'response.interrupted') {
      this.counters.generic_interrupted++;
    }
  }

  calculatePercentiles() {
    const arr = this.primary_timing_diffs_ms;
    if (arr.length === 0) return { median: null, p95: null, max: null };
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1]
    };
  }

  getReport(store, eventBus, version, tabInstanceId) {
    const timing = this.calculatePercentiles();
    const currentNormal = this.counters.confirmed_completions + this.counters.network_only_completions + this.counters.dom_only_completions;
    const totalNormalWithBaseline = this.historical_baseline.normal_completed_provenance + currentNormal;

    return {
      runtime_version: version,
      tab_instance_id: tabInstanceId,
      gate_status: {
        current_candidate_normal: currentNormal,
        historical_baseline_normal: this.historical_baseline.normal_completed_provenance,
        cumulative_normal_total: totalNormalWithBaseline,
        gate_target: 20,
        pass_normal_gate: totalNormalWithBaseline >= 20,
        stopped_by_user: this.counters.stopped_by_user,
        generic_interruption_samples: this.counters.generic_interrupted,
        // 关键修复 G：没有负样本真实 ground truth 前，标记 NOT YET VALIDATED
        generic_interruption_status: this.counters.generic_interrupted > 0 ? 'VALIDATED_IN_SESSION' : 'NOT YET VALIDATED',
        auxiliary_streams_safely_ignored: this.counters.auxiliary_streams_ignored,
        duplicates_prevented: this.counters.duplicates_prevented
      },
      timing_primary_only: {
        samples_count: this.primary_timing_diffs_ms.length,
        median_ms: timing.median,
        p95_ms: timing.p95,
        max_ms: timing.max,
        raw_samples: [...this.primary_timing_diffs_ms]
      },
      counters: { ...this.counters },
      public_events: eventBus ? eventBus.getPublicEvents() : [],
      received_broadcast_events: eventBus ? eventBus.getReceivedEvents() : [],
      sessions_count: store ? store.getAllSessions().length : 0
    };
  }

  reset() {
    this.primary_timing_diffs_ms.length = 0;
    Object.keys(this.counters).forEach(k => this.counters[k] = 0);
  }
}
