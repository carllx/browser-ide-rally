import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

function createTempStorage() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-registry-guard-'));
  return {
    filePath: path.join(tmpDir, 'registry.json'),
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true })
  };
}

test('[Onboarding Registry Guards] 1. 严格拒绝重复的 Project Display Name（大小写不敏感匹配）', () => {
  const registry = createProjectRegistry();

  const b1 = createBinding({
    binding_id: 'proj-1',
    display_name: 'Project Alpha',
    browser: { provider: 'chatgpt', conversation_id: 'conv-b-1' },
    ide: { conversation_id: 'conv-i-1', workspace_identity: '/ws/1', repository_identity: 'repo/1' }
  });
  registry.registerProject({ binding: b1 });

  // 相同名称（不同大小写）
  const b2 = createBinding({
    binding_id: 'proj-2',
    display_name: 'project alpha',
    browser: { provider: 'chatgpt', conversation_id: 'conv-b-2' },
    ide: { conversation_id: 'conv-i-2', workspace_identity: '/ws/2', repository_identity: 'repo/2' }
  });

  assert.throws(() => {
    registry.registerProject({ binding: b2 });
  }, /display_name "project alpha" is already registered/i);
});

test('[Onboarding Registry Guards] 2. 严格拒绝重复的 Browser conversation_id', () => {
  const registry = createProjectRegistry();

  const b1 = createBinding({
    binding_id: 'proj-1',
    display_name: 'Project One',
    browser: { provider: 'chatgpt', conversation_id: 'shared-browser-conv' },
    ide: { conversation_id: 'conv-i-1', workspace_identity: '/ws/1', repository_identity: 'repo/1' }
  });
  registry.registerProject({ binding: b1 });

  const b2 = createBinding({
    binding_id: 'proj-2',
    display_name: 'Project Two',
    browser: { provider: 'chatgpt', conversation_id: 'shared-browser-conv' },
    ide: { conversation_id: 'conv-i-2', workspace_identity: '/ws/2', repository_identity: 'repo/2' }
  });

  assert.throws(() => {
    registry.registerProject({ binding: b2 });
  }, /Browser conversation_id "shared-browser-conv" is already registered/i);
});

test('[Onboarding Registry Guards] 3. 严格拒绝重复的 IDE conversation_id', () => {
  const registry = createProjectRegistry();

  const b1 = createBinding({
    binding_id: 'proj-1',
    display_name: 'Project One',
    browser: { provider: 'chatgpt', conversation_id: 'conv-b-1' },
    ide: { conversation_id: 'shared-ide-conv', workspace_identity: '/ws/1', repository_identity: 'repo/1' }
  });
  registry.registerProject({ binding: b1 });

  const b2 = createBinding({
    binding_id: 'proj-2',
    display_name: 'Project Two',
    browser: { provider: 'chatgpt', conversation_id: 'conv-b-2' },
    ide: { conversation_id: 'shared-ide-conv', workspace_identity: '/ws/2', repository_identity: 'repo/2' }
  });

  assert.throws(() => {
    registry.registerProject({ binding: b2 });
  }, /IDE conversation_id "shared-ide-conv" is already registered/i);
});

test('[Onboarding Registry Guards] 4. 首次 registerProject 立即通过持久化缝隙落盘（无后续 mutation 亦可还原）', () => {
  const temp = createTempStorage();
  try {
    const reg1 = createProjectRegistry({ storagePath: temp.filePath });
    const b1 = createBinding({
      binding_id: 'proj-durable-first',
      display_name: 'First Durable Project',
      browser: { provider: 'chatgpt', conversation_id: 'conv-b-dur' },
      ide: { conversation_id: 'conv-i-dur', workspace_identity: '/ws/dur', repository_identity: 'repo/dur' }
    });

    reg1.registerProject({ binding: b1 });
    // 验证文件在无需任何 mutation 操作的前提下已经存在于磁盘
    assert.equal(fs.existsSync(temp.filePath), true);

    // 模拟重启：全新加载
    const reg2 = createProjectRegistry({ storagePath: temp.filePath });
    assert.equal(reg2.hasProject('proj-durable-first'), true);
    const snap = reg2.getProject('proj-durable-first').getSnapshot();
    assert.equal(snap.binding.display_name, 'First Durable Project');
    assert.equal(snap.binding.browser.conversation_id, 'conv-b-dur');
  } finally {
    temp.cleanup();
  }
});
