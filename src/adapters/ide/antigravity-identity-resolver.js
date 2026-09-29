/**
 * Antigravity 会话身份校验与自动派生模块 (Antigravity Identity Resolver)
 * 
 * 领域不变式与规范准则 (#40):
 * 1. 唯一真实元数据来源：通过 agentapi get-conversation-metadata 从 Antigravity 实时提取元数据；
 * 2. 自动派生身份：由 provider metadata 派生 workspace_identity 与 repository_identity，不依赖用户手填或旧 DOM 字段；
 * 3. 跨项目唯一性：严格排查 registry 中是否存在跨项目已占用的 IDE 会话（Zero-mutation fail-closed）；
 * 4. 健壮容错与明确提示：当会话不存在、无法访问、无配置工作区或格式异常时，输出可操作的具体错误原因；
 * 5. 复用性：全面服务于 Onboarding 引导与 IDE Rebind 端点重绑，严禁第二套解析逻辑。
 */

import { parseCanonicalRepositoryIdentity } from './antigravity-adapter.js';
import {
  DEFAULT_AGENTAPI_BIN,
  defaultAgentApiExecutor,
  normalizeIdentityUri
} from '../production-runtime-controls.js';

/**
 * 清理并规范化 Antigravity 会话 ID（过滤不可见 unicode 控制符、零宽字符、BOM，以及首尾空白与引号）
 * 严格保留 fail-closed exact-ID 语义
 * @param {string} input
 * @returns {string}
 */
export function sanitizeIdeConversationId(input) {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * 校验指定 IDE 会话 ID 在 Registry 中是否唯一且未被其他项目占用
 * @param {import('../../registry/project-registry.js').ProjectRegistry} registry
 * @param {string} cleanIdeConvId
 * @param {object} [options]
 * @param {string} [options.excludeBindingId] 排除检查的当前项目 ID (用于 Rebind)
 * @param {string} [options.excludeEndpointId] 排除检查的当前端点 ID (用于同端点 Rebind)
 */
export function assertIdeConversationUnique(registry, cleanIdeConvId, { excludeBindingId = null, excludeEndpointId = null } = {}) {
  if (!registry || typeof registry.listProjects !== 'function') return;
  if (!cleanIdeConvId) return;

  for (const proj of registry.listProjects()) {
    const isTargetProj = proj.binding?.binding_id === excludeBindingId;

    for (const ep of proj.binding?.ide_endpoints || []) {
      if (isTargetProj && excludeEndpointId && ep.endpoint_id === excludeEndpointId) {
        continue;
      }
      if (ep.conversation_id === cleanIdeConvId) {
        const projLabel = proj.binding?.display_name || proj.binding?.binding_id;
        throw new Error(`Antigravity conversation "${cleanIdeConvId}" is already bound to project "${projLabel}".`);
      }
    }
  }
}

/**
 * 调用 Antigravity provider 获取会话元数据并自动派生工作区与代码仓库身份
 * @param {object} params
 * @param {string} params.conversationId
 * @param {string} [params.agentApiBin]
 * @param {Function} [params.agentApiExecutor]
 * @returns {{ conversation_id: string, workspace_identity: string, repository_identity: string, metadata: object }}
 */
export function deriveAntigravityConversationIdentity({
  conversationId,
  agentApiBin = DEFAULT_AGENTAPI_BIN,
  agentApiExecutor = defaultAgentApiExecutor
}) {
  const cleanIdeConvId = sanitizeIdeConversationId(conversationId);
  if (!cleanIdeConvId) {
    throw new Error('Antigravity conversation ID is required.');
  }

  const executor = agentApiExecutor || defaultAgentApiExecutor;
  const bin = agentApiBin || DEFAULT_AGENTAPI_BIN;

  let rawMeta;
  try {
    rawMeta = executor(bin, ['get-conversation-metadata', cleanIdeConvId]);
  } catch (err) {
    const errorDetails = err.stderr ? err.stderr.toString().trim() : (err.stdout ? err.stdout.toString().trim() : (err.message || ''));
    const error = new Error(`Antigravity conversation "${cleanIdeConvId}" not found or inaccessible. Please check the conversation ID and ensure Antigravity is running.`);
    error.details = errorDetails;
    throw error;
  }

  let meta;
  try {
    meta = JSON.parse(rawMeta);
  } catch (e) {
    throw new Error(`Failed to parse Antigravity metadata for conversation "${cleanIdeConvId}": ${e.message}`);
  }

  const workspaces = meta?.response?.conversationMetadata?.metadata?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error(`Antigravity conversation "${cleanIdeConvId}" has no configured workspaces.`);
  }

  const ws = workspaces[0];
  const workspaceIdentity = normalizeIdentityUri(ws.workspaceFolderAbsoluteUri || '');
  const repositoryIdentity = ws.repository?.computedName ||
    parseCanonicalRepositoryIdentity(ws.repository?.gitOriginUrl) ||
    '';

  if (!workspaceIdentity || !repositoryIdentity) {
    throw new Error(`Antigravity conversation "${cleanIdeConvId}" workspace or repository identity could not be derived.`);
  }

  return {
    conversation_id: cleanIdeConvId,
    workspace_identity: workspaceIdentity,
    repository_identity: repositoryIdentity,
    metadata: meta
  };
}

/**
 * 校验并验证 IDE Rebind 请求的目标身份，自动得出权威工作区与仓库信息
 * @param {object} params
 * @param {import('../../registry/project-registry.js').ProjectRegistry} params.registry
 * @param {string} params.bindingId
 * @param {string} params.targetEndpoint
 * @param {string} params.conversationId
 * @param {string} [params.agentApiBin]
 * @param {Function} [params.agentApiExecutor]
 * @returns {{ conversation_id: string, workspace_identity: string, repository_identity: string }}
 */
export function verifyAndResolveIdeRebindIdentity({
  registry,
  bindingId,
  targetEndpoint,
  conversationId,
  agentApiBin = DEFAULT_AGENTAPI_BIN,
  agentApiExecutor = defaultAgentApiExecutor
}) {
  const cleanConvId = sanitizeIdeConversationId(conversationId);
  if (!cleanConvId) {
    throw new Error('Antigravity conversation ID is required.');
  }

  // 1. 跨项目唯一性排查 (若已绑定到其他项目则明确拒绝，零变更)
  assertIdeConversationUnique(registry, cleanConvId, {
    excludeBindingId: bindingId,
    excludeEndpointId: targetEndpoint
  });

  // 2. 通过 Antigravity metadata 验证并自动派生工作区与仓库
  const derived = deriveAntigravityConversationIdentity({
    conversationId: cleanConvId,
    agentApiBin,
    agentApiExecutor
  });

  return {
    conversation_id: derived.conversation_id,
    workspace_identity: derived.workspace_identity,
    repository_identity: derived.repository_identity
  };
}
