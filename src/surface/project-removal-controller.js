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

  // 前置提取该项目 IDE 端点信息与受影响工作区集合，用于移出后的 Hook 权威对齐 (Blocker 2)
  let ideEndpointsToClean = [];
  const affectedWorkspaces = new Set();
  try {
    const snap = registry.getProject(bindingId).getSnapshot();
    ideEndpointsToClean = snap.binding?.ide_endpoints || [];
    for (const ep of ideEndpointsToClean) {
      if (ep.workspace_identity) {
        affectedWorkspaces.add(ep.workspace_identity);
      }
    }
  } catch (_) {}

  // 1. 执行注册表原子移出（严格锁 revision，写盘失败自动回滚）
  try {
    registry.removeProject(bindingId, {
      expected_binding_revision: body.expected_binding_revision
    });
  } catch (err) {
    return handleControlError(res, err);
  }

  // 2. 注册表提交后，以移出后的 active registry 权威真值对齐 Hook 订阅 (Blocker 2)
  // 遵循契约：Hook 清理异常为 fail-visible，绝不回滚或损坏 active registry
  const hookMgr = workspaceHookManager || observationCoordinator?.workspaceHookManager;
  if (hookMgr) {
    try {
      if (typeof hookMgr.reconcileWorkspacesAfterRemoval === 'function') {
        hookMgr.reconcileWorkspacesAfterRemoval(registry, Array.from(affectedWorkspaces));
      } else if (typeof hookMgr.removeWorkspaceHook === 'function') {
        for (const ep of ideEndpointsToClean) {
          if (ep.workspace_identity && ep.conversation_id) {
            hookMgr.removeWorkspaceHook(ep.workspace_identity, ep.conversation_id);
          }
        }
      }
    } catch (cleanupErr) {
      logger?.warn?.(
        `[ProjectRemovalController] Failed to reconcile workspace hooks after removal of ${bindingId}: ${cleanupErr.message}`
      );
    }
  }

  // 3. 响应操作者，使用面向普通用户的人类后果语言 (Blocker 3)
  return sendJson(res, 200, {
    success: true,
    message: '只从 Rally 项目列表中移出，不会删除对话或代码仓库',
    binding_id: bindingId
  });
}
