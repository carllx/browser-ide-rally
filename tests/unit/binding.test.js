import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBinding,
  validateBinding,
  bumpRevision,
  pauseBinding,
  resumeBinding
} from '../../src/controller/binding.js';

test('[单元测试] Binding: 成功创建具有默认能力的合法 binding 实例', () => {
  const binding = createBinding({
    binding_id: 'bind-001',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-123'
    },
    ide: {
      conversation_id: 'conv-ide-456',
      workspace_identity: 'file:///workspace/repo',
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  assert.equal(binding.binding_id, 'bind-001');
  assert.equal(binding.binding_revision, 1);
  assert.equal(binding.browser.conversation_id, 'conv-browser-123');
  assert.equal(binding.ide.conversation_id, 'conv-ide-456');
  assert.deepEqual(binding.capabilities, ['rally.echo']);
  assert.equal(binding.paused, false);
});

test('[单元测试] Binding: 拒绝非法或缺失字段', () => {
  assert.throws(() => {
    createBinding({ binding_id: '' });
  }, /Invalid Binding creation/);

  assert.throws(() => {
    createBinding({
      binding_id: 'b1',
      binding_revision: 0
    });
  }, /Invalid Binding creation/);

  assert.throws(() => {
    createBinding({
      binding_id: 'b1',
      browser: { provider: 'chatgpt', conversation_id: '' }
    });
  }, /Invalid Binding creation/);
});

test('[单元测试] Binding: 正确递增版本号', () => {
  const binding = createBinding({
    binding_id: 'bind-001',
    browser: { provider: 'chatgpt', conversation_id: 'c1' },
    ide: { conversation_id: 'c2', workspace_identity: 'w1', repository_identity: 'r1' }
  });

  const bumped = bumpRevision(binding);
  assert.equal(bumped.binding_revision, 2);
  assert.ok(typeof bumped.updated_at === 'string' && bumped.updated_at.length > 0);
});

test('[单元测试] Binding: 正确流转暂停与恢复状态', () => {
  const binding = createBinding({
    binding_id: 'bind-001',
    browser: { provider: 'chatgpt', conversation_id: 'c1' },
    ide: { conversation_id: 'c2', workspace_identity: 'w1', repository_identity: 'r1' }
  });

  const paused = pauseBinding(binding);
  assert.equal(paused.paused, true);

  const resumed = resumeBinding(paused);
  assert.equal(resumed.paused, false);
});
