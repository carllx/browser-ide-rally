/**
 * 项目移出控制器模块 (Project Removal Controller)
 * 遵循 Issue #36 契约：
 * 1. 位于 #28 安全门禁保护下；
 * 2. 严格校验 exact binding_id 与 exact expected_binding_revision；
 * 3. 缺失或过期版本严格 fail-closed (409 BLOCKED) 并保证 Zero Mutation；
 * 4. 成功移出后异步/顺畅触发孤立 Hook 资源清理；
 * 5. Hook 清理失败为 fail-visible，绝不回滚或破坏权威注册表状态；
 * 6. 返回面向人类的友好后果语言，不暴露内部结果状态术语。
 */

import { sendJson, parseBody } from './http-helpers.js';
import { handleControlError } from './control-error-handler.js';

/**
 * 处理项目移出请求
 * @param {object} params
 * @param {import('node:http').IncomingMessage} params.req
 * @param {import('node:http').ServerResponse} params.res
 * @param {string} params.bindingId
 * @param {import('../registry/project-registry.js').ProjectRegistry} params.registry
 * @param {object} [params.observationCoordinator]
 * @param {object} [params.workspaceHookManager]
 * @param {object} [params.logger=console]
 */
export async function handleProjectRemovalRequest({
  req,
  res,
  bindingId,
  registry,
  observationCoordinator = null,
  workspaceHookManager = null,
  logger = console
}) {
  let body = {};
  try {
    body = await parseBody(req);
  } catch (err) {
    return sendJson(res, 400, { success: false, reason: err.message });
  }

  if (!registry.hasProject(bindingId)) {
    return sendJson(res, 404, { success: false, reason: `Project "${bindingId}" not found in active registry` });
  }

  // 前置提取该项目 IDE 端点信息，用于移出后的 Hook 清理
  let ideEndpointsToClean = [];
  try {
    const snap = registry.getProject(bindingId).getSnapshot();
    ideEndpointsToClean = snap.binding?.ide_endpoints || [];
  } catch (_) {}

  // 1. 执行注册表原子移出（严格锁 revision，写盘失败自动回滚）
  try {
    registry.removeProject(bindingId, {
      expected_binding_revision: body.expected_binding_revision
    });
  } catch (err) {
    return handleControlError(res, err);
  }

  // 2. 注册表提交后，执行本地 Hook 订阅清理 (Seam 3)
  // 遵循契约：Hook 清理异常为 fail-visible，绝不回滚或损坏 active registry
  const hookMgr = workspaceHookManager || observationCoordinator?.workspaceHookManager;
  if (hookMgr && typeof hookMgr.removeWorkspaceHook === 'function') {
    for (const ep of ideEndpointsToClean) {
      const ws = ep.workspace_identity;
      const convId = ep.conversation_id;
      if (ws && convId) {
        try {
          hookMgr.removeWorkspaceHook(ws, convId);
        } catch (cleanupErr) {
          logger?.warn?.(
            `[ProjectRemovalController] Failed to cleanup workspace hook for ${ws} conv ${convId}: ${cleanupErr.message}`
          );
        }
      }
    }
  }

  // 3. 响应操作者，使用明确的人类后果语言
  return sendJson(res, 200, {
    success: true,
    message: '项目已从活跃工作区移出，已留存历史事实且未修改外部会话或代码仓库',
    binding_id: bindingId
  });
}
