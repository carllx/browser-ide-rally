/**
 * 状态表面 Webhook 控制器模块 (Surface Hook Controller)
 * 封装并隔离外部 Webhook 事件的接收与分发，防止主服务路由文件膨胀
 */

/**
 * 处理 Antigravity Stop Hook HTTP 请求
 * @param {object} params
 * @param {object} params.body - 请求体
 * @param {object} params.observationCoordinator - 观察协调器
 * @returns {{ statusCode: number, payload: object }}
 */
export function handleAntigravityHookRequest({ body, observationCoordinator }) {
  if (!observationCoordinator || typeof observationCoordinator.handleAntigravityHook !== 'function') {
    return {
      statusCode: 503,
      payload: { success: false, reason: 'observation_coordinator_not_configured' }
    };
  }

  try {
    const result = observationCoordinator.handleAntigravityHook(body);
    return {
      statusCode: 200,
      payload: { success: Boolean(result?.accepted), result }
    };
  } catch (err) {
    return {
      statusCode: 500,
      payload: { success: false, reason: err.message }
    };
  }
}
