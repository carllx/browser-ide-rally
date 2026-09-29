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

  it('3. deriveAntigravityConversationIdentity 异常拦截：会话缺失、执行失败或元数据缺失时给出明确可操作错误', () => {
    // 缺失会话 ID
    assert.throws(
      () => deriveAntigravityConversationIdentity({ conversationId: '' }),
      /Antigravity conversation ID is required/
    );

    // 会话不存在或执行失败 (agentapi 抛出异常)
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-nonexistent',
        agentApiExecutor: () => {
          const err = new Error('Process exited with code 1');
          err.stderr = 'Conversation conv-nonexistent not found';
          throw err;
        }
      }),
      /Antigravity conversation "conv-nonexistent" not found or inaccessible/
    );

    // 元数据无工作区
    assert.throws(
      () => deriveAntigravityConversationIdentity({
        conversationId: 'conv-no-ws',
        agentApiExecutor: () => JSON.stringify({
          response: { conversationMetadata: { metadata: { workspaces: [] } } }
        })
      }),
      /has no configured workspaces/
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
});
