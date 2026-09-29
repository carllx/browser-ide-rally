/**
 * Antigravity Identity Resolver 单元测试
 * 验证会话 ID 规范化、跨项目唯一性校验与基于 provider metadata 的身份自动派生
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeIdeConversationId,
  assertIdeConversationUnique,
  deriveAntigravityConversationIdentity,
  verifyAndResolveIdeRebindIdentity
} from '../../src/adapters/ide/antigravity-identity-resolver.js';
import { resolveDefaultAgentApiBin } from '../../src/adapters/production-runtime-controls.js';

describe('Antigravity Identity Resolver 单元测试', () => {
  it('1. sanitizeIdeConversationId 安全规范化：清洗零宽字符、BOM、引号与前后空白', () => {
    assert.equal(sanitizeIdeConversationId('  conv-123  '), 'conv-123');
    assert.equal(sanitizeIdeConversationId('"conv-quoted"'), 'conv-quoted');
    assert.equal(sanitizeIdeConversationId("'conv-single-quoted'"), 'conv-single-quoted');
    assert.equal(sanitizeIdeConversationId('\uFEFFconv-bom\u200B'), 'conv-bom');
    assert.equal(sanitizeIdeConversationId(null), '');
    assert.equal(sanitizeIdeConversationId(undefined), '');
  });

  it('2. assertIdeConversationUnique 跨项目唯一性排查：跨项目已被占用时 Fail-Closed 抛出明确错误', () => {
    const mockRegistry = {
      listProjects: () => [
        {
          binding: {
            binding_id: 'proj-other',
            display_name: 'Other Project',
            ide_endpoints: [{ endpoint_id: 'ide-primary', conversation_id: 'conv-in-use' }]
          }
        },
        {
          binding: {
            binding_id: 'proj-current',
            display_name: 'Current Project',
            ide_endpoints: [{ endpoint_id: 'ide-1', conversation_id: 'conv-self' }]
          }
        }
      ]
    };

    // 跨项目冲突：抛出明确异常
    assert.throws(
      () => assertIdeConversationUnique(mockRegistry, 'conv-in-use', { excludeBindingId: 'proj-current' }),
      /Antigravity conversation "conv-in-use" is already bound to project "Other Project"/
    );

    // 重新绑定自己当前的端点：排除自身 binding + endpoint 后放行
    assert.doesNotThrow(() => {
      assertIdeConversationUnique(mockRegistry, 'conv-self', {
        excludeBindingId: 'proj-current',
        excludeEndpointId: 'ide-1'
      });
    });

    // 全新未使用的 conversation ID：放行
    assert.doesNotThrow(() => {
      assertIdeConversationUnique(mockRegistry, 'conv-brand-new', { excludeBindingId: 'proj-current' });
    });
  });

  it('3. deriveAntigravityConversationIdentity 异常拦截：精准保留真实错误分类与底层细节', () => {
    // 缺失会话 ID
    assert.throws(
      () => deriveAntigravityConversationIdentity({ conversationId: '' }),
      (err) => err.category === 'INVALID_CONVERSATION_ID' && /Antigravity conversation ID is required/.test(err.message)
    );

    // 1. 可执行文件缺失 (ENOENT)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-test',
        agentApiExecutor: () => {
          const err = new Error('spawn agentapi ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
      }),
      (err) => err.category === 'EXECUTABLE_NOT_FOUND' && /executable not found/.test(err.message)
    );

    // 2. 权限受阻 (EACCES)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-test',
        agentApiExecutor: () => {
          const err = new Error('spawn agentapi EACCES');
          err.code = 'EACCES';
          throw err;
        }
      }),
      (err) => err.category === 'PERMISSION_DENIED' && /permission denied/.test(err.message)
    );

    // 3. Provider 返回明确会话不存在证据 (CONVERSATION_NOT_FOUND)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-nonexistent',
        agentApiExecutor: () => {
          const err = new Error('Process exited with code 1');
          err.stderr = 'rpc error: code = Unknown desc = trajectory not found: conv-nonexistent';
          throw err;
        }
      }),
      (err) => err.category === 'CONVERSATION_NOT_FOUND' && /Antigravity conversation "conv-nonexistent" not found or inaccessible/.test(err.message)
    );

    // 4. Provider 退出非零但属于环境/IPC 错误 (PROVIDER_COMMAND_FAILED，严禁粗暴当作会话不存在)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-valid',
        agentApiExecutor: () => {
          const err = new Error('Process exited with code 1');
          err.stderr = '{"error": "ANTIGRAVITY_LS_ADDRESS is not set"}';
          throw err;
        }
      }),
      (err) => err.category === 'PROVIDER_COMMAND_FAILED' && /ANTIGRAVITY_LS_ADDRESS is not set/.test(err.message)
    );

    // 5. 元数据非 JSON (MALFORMED_OUTPUT)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-bad-json',
        agentApiExecutor: () => 'NOT_VALID_JSON'
      }),
      (err) => err.category === 'MALFORMED_OUTPUT' && /Failed to parse Antigravity metadata/.test(err.message)
    );

    // 6. 元数据无工作区 (NO_WORKSPACES)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-no-ws',
        agentApiExecutor: () => JSON.stringify({
          response: { conversationMetadata: { metadata: { workspaces: [] } } }
        })
      }),
      (err) => err.category === 'NO_WORKSPACES' && /has no configured workspaces/.test(err.message)
    );
  });

  it('4. deriveAntigravityConversationIdentity 成功派生：从 provider metadata 正确解析 workspace 与 repository', () => {
    const mockMeta = {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///Users/dev/repo-test',
                repository: {
                  gitOriginUrl: 'https://github.com/my-org/my-repo.git',
                  computedName: 'my-org/my-repo'
                }
              }
            ]
          }
        }
      }
    };

    const derived = deriveAntigravityConversationIdentity({
      conversationId: 'conv-valid-123',
      agentApiExecutor: () => JSON.stringify(mockMeta)
    });

    assert.equal(derived.conversation_id, 'conv-valid-123');
    assert.equal(derived.workspace_identity, '/Users/dev/repo-test');
    assert.equal(derived.repository_identity, 'my-org/my-repo');
  });

  it('5. verifyAndResolveIdeRebindIdentity 综合流程：串联排他检查与派生', () => {
    const mockRegistry = {
      listProjects: () => [
        {
          binding: {
            binding_id: 'proj-alpha',
            display_name: 'Alpha Project',
            ide_endpoints: [{ endpoint_id: 'ide-primary', conversation_id: 'conv-alpha-old' }]
          }
        }
      ]
    };

    const mockMeta = {
      response: {
        conversationMetadata: {
          metadata: {
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///Users/dev/repo-alpha',
                repository: {
                  gitOriginUrl: 'git@github.com:my-org/repo-alpha.git'
                }
              }
            ]
          }
        }
      }
    };

    const resolved = verifyAndResolveIdeRebindIdentity({
      registry: mockRegistry,
      bindingId: 'proj-alpha',
      targetEndpoint: 'ide-primary',
      conversationId: 'conv-alpha-new',
      agentApiExecutor: () => JSON.stringify(mockMeta)
    });

    assert.equal(resolved.conversation_id, 'conv-alpha-new');
    assert.equal(resolved.workspace_identity, '/Users/dev/repo-alpha');
    assert.equal(resolved.repository_identity, 'my-org/repo-alpha');
  });

  it('6. resolveDefaultAgentApiBin 路径解析优先级：显式参数 > 环境变量 > 用户家目录路径', () => {
    // 显式传入优先
    assert.equal(resolveDefaultAgentApiBin('/custom/bin/agentapi'), '/custom/bin/agentapi');

    const origEnv = { ...process.env };
    try {
      // 环境变量优先于家目录
      process.env.AGENTAPI_BIN = '/env/bin/agentapi';
      assert.equal(resolveDefaultAgentApiBin(), '/env/bin/agentapi');

      delete process.env.AGENTAPI_BIN;
      process.env.ANTIGRAVITY_BIN = '/exe/bin/agentapi';
      assert.equal(resolveDefaultAgentApiBin(), '/exe/bin/agentapi');

      // 显式传入仍优先于环境变量
      assert.equal(resolveDefaultAgentApiBin('/explicit/agentapi'), '/explicit/agentapi');
    } finally {
      process.env = origEnv;
    }
  });
});
