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
  resolveDefaultAgentApiBin,
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
        const err = new Error(`Antigravity conversation "${cleanIdeConvId}" is already bound to project "${projLabel}".`);
        err.category = 'CONVERSATION_ALREADY_BOUND';
        throw err;
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
  agentApiBin = null,
  agentApiExecutor = defaultAgentApiExecutor
}) {
  const cleanIdeConvId = sanitizeIdeConversationId(conversationId);
  if (!cleanIdeConvId) {
    const err = new Error('Antigravity conversation ID is required.');
    err.category = 'INVALID_CONVERSATION_ID';
    throw err;
  }

  const executor = agentApiExecutor || defaultAgentApiExecutor;
  const bin = resolveDefaultAgentApiBin(agentApiBin);

  let rawMeta;
  try {
    rawMeta = executor(bin, ['get-conversation-metadata', cleanIdeConvId]);
  } catch (err) {
    const code = err.code;
    const rawStderr = err.stderr ? err.stderr.toString().trim() : '';
    const rawStdout = err.stdout ? err.stdout.toString().trim() : '';
    const details = rawStderr || rawStdout || err.message || '';

    // 1. 可执行文件缺失 (ENOENT)
    if (code === 'ENOENT') {
      const error = new Error(`Antigravity agentapi executable not found at "${bin}". Please check your installation or AGENTAPI_BIN environment variable.`);
      error.category = 'EXECUTABLE_NOT_FOUND';
      error.details = details;
      throw error;
    }

    // 2. 执行权限受阻 (EACCES)
    if (code === 'EACCES') {
      const error = new Error(`Antigravity agentapi executable at "${bin}" permission denied.`);
      error.category = 'PERMISSION_DENIED';
      error.details = details;
      throw error;
    }

    // 3. 仅当 provider 明确返回会话不存在证据时，才归类为 genuine not-found
    const lower = details.toLowerCase();
    const isExplicitNotFound = lower.includes('trajectory not found') ||
                               lower.includes('not found: ' + cleanIdeConvId.toLowerCase()) ||
                               lower.includes('conversation not found') ||
                               (lower.includes('conversation') && lower.includes('not found')) ||
                               lower.includes('unknown desc = trajectory not found');
    if (isExplicitNotFound) {
      const error = new Error(`Antigravity conversation "${cleanIdeConvId}" not found or inaccessible.`);
      error.category = 'CONVERSATION_NOT_FOUND';
      error.details = details;
      throw error;
    }

    // 4. 其他 provider 命令行执行非零失败（例如缺少环境变量、IPC 通信失败等），严格保留真实错误细节
    const error = new Error(`Antigravity provider lookup failed: ${details || err.message}`);
    error.category = 'PROVIDER_COMMAND_FAILED';
    error.details = details;
    throw error;
  }

  let meta;
  try {
    meta = JSON.parse(rawMeta);
  } catch (e) {
    const error = new Error(`Failed to parse Antigravity metadata for conversation "${cleanIdeConvId}": ${e.message}`);
    error.category = 'MALFORMED_OUTPUT';
    error.details = rawMeta;
    throw error;
  }

  const workspaces = meta?.response?.conversationMetadata?.metadata?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    const error = new Error(`Antigravity conversation "${cleanIdeConvId}" has no configured workspaces.`);
    error.category = 'NO_WORKSPACES';
    throw error;
  }

  const ws = workspaces[0];
  const workspaceIdentity = normalizeIdentityUri(ws.workspaceFolderAbsoluteUri || '');
  const repositoryIdentity = ws.repository?.computedName ||
    parseCanonicalRepositoryIdentity(ws.repository?.gitOriginUrl) ||
    '';

  if (!workspaceIdentity || !repositoryIdentity) {
    const error = new Error(`Antigravity conversation "${cleanIdeConvId}" workspace or repository identity could not be derived.`);
    error.category = 'IDENTITY_DERIVATION_FAILED';
    throw error;
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
  agentApiBin = null,
  agentApiExecutor = defaultAgentApiExecutor
}) {
  const cleanConvId = sanitizeIdeConversationId(conversationId);
  if (!cleanConvId) {
    const err = new Error('Antigravity conversation ID is required.');
    err.category = 'INVALID_CONVERSATION_ID';
    throw err;
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
