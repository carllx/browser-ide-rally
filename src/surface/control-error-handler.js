/**
 * 控制器错误响应处理辅助模块 (Control Error Handler)
 * 统一将控制器业务异常转化为规范 HTTP 状态码与响应体 (BLOCKED -> 409, FAILED -> 400)
 */

import { sendJson } from './http-helpers.js';

/**
 * 处理控制端点异常并映射为 HTTP 响应
 * @param {import('node:http').ServerResponse} res
 * @param {any} err
 * @param {string} [defaultStage='BLOCKED']
 */
export function handleControlError(res, err, defaultStage = 'BLOCKED') {
  const msg = err?.message || String(err);
  const stage = err?.actionStage || defaultStage;
  const isBlocked = stage === 'BLOCKED' ||
                    msg.includes('STALE_OR_MISSING_BINDING_REVISION') ||
                    msg.includes('BLOCKED') ||
                    msg.includes('unhandled NEW') ||
                    msg.includes('UNKNOWN') ||
                    msg.includes('SECURITY_REJECT') ||
                    msg.includes('IDE_ENDPOINT_NOT_FOUND') ||
                    msg.includes('TARGET_LOOKUP_FAIL') ||
                    msg.includes('FOCUS_NOT_AVAILABLE') ||
                    msg.includes('FOCUS_NOT_SUPPORTED') ||
                    msg.includes('IDENTITY_MISMATCH') ||
                    msg.includes('IDENTITY_VERIFY_FAIL') ||
                    msg.includes('SOURCE_ENDPOINT_REQUIRED') ||
                    msg.includes('SOURCE_ENDPOINT_UNKNOWN') ||
                    msg.includes('STALE_SOURCE_CONTEXT') ||
                    msg.includes('SOURCE_RESULT_UNAVAILABLE') ||
                    msg.includes('PAYLOAD_TOO_LARGE') ||
                    msg.includes('INVALID_SOURCE_ENDPOINT') ||
                    msg.includes('PREFLIGHT_BLOCKED');
  const finalStage = stage === 'FAILED' ? 'FAILED' : (isBlocked ? 'BLOCKED' : 'FAILED');
  return sendJson(res, finalStage === 'BLOCKED' ? 409 : 400, {
    success: false,
    stage: finalStage,
    reason: msg,
    ...(err?.category ? { category: err.category } : {}),
    ...(err?.details ? { details: err.details } : {})
  });
}
