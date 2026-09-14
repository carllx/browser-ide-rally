/**
 * 常量与枚举定义
 */
export const STREAM_CLASS = Object.freeze({
  PRIMARY_GENERATION: 'PRIMARY_GENERATION',
  AUXILIARY_STREAM: 'AUXILIARY_STREAM',
  UNKNOWN: 'UNKNOWN'
});

export const EVENTS = Object.freeze({
  STARTED: 'response.started',
  NETWORK_COMPLETED: 'response.network_completed',
  UI_COMPLETED: 'response.ui_completed',
  COMPLETED: 'response.completed',
  STOPPED_BY_USER: 'response.stopped_by_user',
  INTERRUPTED: 'response.interrupted',
  FAILED: 'response.failed'
});

export const CONFIDENCE = Object.freeze({
  CONFIRMED: 'confirmed',
  NETWORK_ONLY: 'network_only',
  DOM_ONLY: 'dom_only'
});

export const CONFIG = Object.freeze({
  GRACE_WINDOW_MS: 400,
  BROADCAST_CHANNEL_NAME: 'chatgpt-runtime-events'
});
