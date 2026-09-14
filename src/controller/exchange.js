/**
 * Single Exchange 记录与状态机
 * 适用场景：当前 MVP 的单一飞行中 (single in-flight) 中继轮次
 */

export const PHASES = {
  PREPARED: 'prepared',
  VALIDATED: 'validated',
  DELIVERED_TO_IDE: 'delivered_to_ide',
  RESULT_OBSERVED: 'result_observed',
  DELIVERED_TO_BROWSER: 'delivered_to_browser',
  BROWSER_ACKNOWLEDGED: 'browser_acknowledged',
  BLOCKED: 'blocked',
  UNKNOWN_DELIVERY: 'unknown_delivery'
};

const VALID_TRANSITIONS = {
  [PHASES.PREPARED]: [PHASES.VALIDATED, PHASES.BLOCKED],
  [PHASES.VALIDATED]: [PHASES.DELIVERED_TO_IDE, PHASES.BLOCKED, PHASES.UNKNOWN_DELIVERY],
  [PHASES.DELIVERED_TO_IDE]: [PHASES.RESULT_OBSERVED, PHASES.BLOCKED, PHASES.UNKNOWN_DELIVERY],
  [PHASES.RESULT_OBSERVED]: [PHASES.DELIVERED_TO_BROWSER, PHASES.BLOCKED, PHASES.UNKNOWN_DELIVERY],
  [PHASES.DELIVERED_TO_BROWSER]: [PHASES.BROWSER_ACKNOWLEDGED, PHASES.BLOCKED, PHASES.UNKNOWN_DELIVERY],
  [PHASES.BROWSER_ACKNOWLEDGED]: [],
  [PHASES.BLOCKED]: [],
  [PHASES.UNKNOWN_DELIVERY]: []
};

/**
 * 创建 Exchange 实例
 */
export function createExchange({
  exchange_id,
  nonce,
  binding_id,
  binding_revision
}) {
  if (!exchange_id || typeof exchange_id !== 'string') {
    throw new Error('exchange_id must be a non-empty string');
  }
  if (!nonce || typeof nonce !== 'string') {
    throw new Error('nonce must be a non-empty string');
  }
  if (!binding_id || typeof binding_id !== 'string') {
    throw new Error('binding_id must be a non-empty string');
  }
  if (!Number.isInteger(binding_revision) || binding_revision < 1) {
    throw new Error('binding_revision must be an integer >= 1');
  }

  return {
    exchange_id,
    nonce,
    binding_id,
    binding_revision,
    phase: PHASES.PREPARED,
    last_evidence: null,
    blocker: null,
    needs_human: false,
    history: [
      {
        phase: PHASES.PREPARED,
        timestamp: new Date().toISOString(),
        evidence: 'Exchange initialized'
      }
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

/**
 * 推进 Exchange 阶段
 */
export function transitionExchange(exchange, nextPhase, { evidence = null, blocker = null, needs_human = false } = {}) {
  const currentPhase = exchange.phase;
  const allowed = VALID_TRANSITIONS[currentPhase] || [];

  if (!allowed.includes(nextPhase)) {
    throw new Error(`Invalid exchange transition from "${currentPhase}" to "${nextPhase}"`);
  }

  exchange.phase = nextPhase;
  exchange.updated_at = new Date().toISOString();

  if (evidence) exchange.last_evidence = evidence;
  if (blocker) exchange.blocker = blocker;
  if (needs_human) exchange.needs_human = true;

  exchange.history.push({
    phase: nextPhase,
    timestamp: exchange.updated_at,
    evidence,
    blocker
  });

  return exchange;
}

/**
 * 标记阻断 (Blocked)
 */
export function markBlocked(exchange, reason, { needs_human = false, evidence = null } = {}) {
  return transitionExchange(exchange, PHASES.BLOCKED, {
    blocker: reason,
    needs_human,
    evidence
  });
}

/**
 * 标记未知投递结果 (Unknown Delivery)
 * 发生网络异常或未确认超时时调用，严禁隐式重试
 */
export function markUnknownDelivery(exchange, reason, { evidence = null } = {}) {
  return transitionExchange(exchange, PHASES.UNKNOWN_DELIVERY, {
    blocker: reason,
    needs_human: true,
    evidence
  });
}
