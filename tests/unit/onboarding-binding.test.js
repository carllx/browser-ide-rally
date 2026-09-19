import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBinding,
  validateBinding,
  bumpRevision,
  pauseBinding,
  resumeBinding
} from '../../src/controller/binding.js';

test('[Onboarding Binding] 1. 成功创建携带合法 display_name 的 binding 实例并自动去除首尾空白', () => {
  const binding = createBinding({
    binding_id: 'proj-101',
    display_name: '  Rally Production Core  ',
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-1'
    },
    ide: {
      conversation_id: 'conv-ide-1',
      workspace_identity: '/Users/rally/workspace',
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  assert.equal(binding.binding_id, 'proj-101');
  assert.equal(binding.display_name, 'Rally Production Core');
});

test('[Onboarding Binding] 2. 未指定 display_name 时保持向后兼容（display_name 为 null 或未定义，不报错）', () => {
  const binding = createBinding({
    binding_id: 'proj-legacy',
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-2'
    },
    ide: {
      conversation_id: 'conv-ide-2',
      workspace_identity: '/Users/rally/workspace',
      repository_identity: 'carllx/browser-ide-rally'
    }
  });

  assert.equal(binding.binding_id, 'proj-legacy');
  assert.equal(binding.display_name === null || binding.display_name === undefined, true);
});

test('[Onboarding Binding] 3. 严格拒绝非字符串或纯空白的非法 display_name', () => {
  // 空字符串
  assert.throws(() => {
    createBinding({
      binding_id: 'proj-bad',
      display_name: '   ',
      browser: { provider: 'chatgpt', conversation_id: 'cb' },
      ide: { conversation_id: 'ci', workspace_identity: 'w', repository_identity: 'r' }
    });
  }, /display_name must be a non-empty string when supplied/);

  // 非字符串类型
  assert.throws(() => {
    createBinding({
      binding_id: 'proj-bad-2',
      display_name: 12345,
      browser: { provider: 'chatgpt', conversation_id: 'cb' },
      ide: { conversation_id: 'ci', workspace_identity: 'w', repository_identity: 'r' }
    });
  }, /display_name must be a non-empty string when supplied/);
});

test('[Onboarding Binding] 4. bumpRevision / pauseBinding / resumeBinding 完整保留 display_name', () => {
  const initial = createBinding({
    binding_id: 'proj-persist',
    display_name: 'My Workspace Project',
    browser: { provider: 'chatgpt', conversation_id: 'cb' },
    ide: { conversation_id: 'ci', workspace_identity: 'w', repository_identity: 'r' }
  });

  const bumped = bumpRevision(initial);
  assert.equal(bumped.binding_revision, 2);
  assert.equal(bumped.display_name, 'My Workspace Project');

  const paused = pauseBinding(bumped);
  assert.equal(paused.paused, true);
  assert.equal(paused.display_name, 'My Workspace Project');

  const resumed = resumeBinding(paused);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.display_name, 'My Workspace Project');
});
