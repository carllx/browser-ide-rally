/**
 * 状态表面安全控制门面协调模块 (Safe Controls Facade Coordinator)
 * 
 * 模块拆分与架构组织 (#18):
 * - safe-controls-common.js: 版本校验、失配记录与端点寻址通用辅助
 * - safe-rebind.js: 安全端点重绑及未处理 NEW/UNKNOWN 守卫
 * - safe-open-focus.js: 端点真实开启聚焦与副作用凭据校验
 * - safe-send.js: 统一 typed payload 发送、精准 Envelope 钉住与真实投递凭据检查
 * - action-correlation.js: 跨轮次动作关联推进至 TARGET_COMPLETED
 */

export {
  generateActionId,
  generateNonce,
  resolveProjectAndValidateRevision,
  recordBlockedAction,
  resolveIdeAdapter
} from './safe-controls-common.js';

export { executeSafeRebind } from './safe-rebind.js';
export { executeSafeOpenFocus } from './safe-open-focus.js';
export { executeSafeSend } from './safe-send.js';
export { correlateAndAdvanceActionCompletion } from './action-correlation.js';
