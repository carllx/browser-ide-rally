/**
 * Registry & Safe Rebind 验收与回归测试套件 (#14)
 * 遵循最高测试缝隙原则：durable facts in → recovery/rebind → snapshot/view out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createBinding } from '../../src/controller/binding.js';
import { createProjectRegistry, CURRENT_SCHEMA_VERSION } from '../../src/registry/project-registry.js';
import { deriveEndpointResult } from '../../src/status/status-core.js';

function createTempStoragePath(prefix = 'rally-test-registry') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir: tmpDir,
    file: path.join(tmpDir, 'registry.json'),
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

function makeSampleBinding(id, overrides = {}) {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: `conv-browser-${id}`
    },
    ide: {
      conversation_id: `conv-ide-${id}`,
      workspace_identity: `file:///workspace/${id}`,
      repository_identity: `carllx/${id}`
    },
    ...overrides
  });
}

test('[Registry] 1. 多项目独立持久化与重启恢复（多项目隔离与完整事实还原）', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const registry1 = createProjectRegistry({ storagePath: file });

    const p1 = registry1.registerProject({ binding: makeSampleBinding('proj-1') });
    const p2 = registry1.registerProject({ binding: makeSampleBinding('proj-2') });

    // 为 proj-1 设置状态：Browser 为 NEW，IDE 为 caught up
    p1.recordEndpointObservation('browser', {
      conversation_id: 'conv-browser-proj-1',
      trusted: true,
      latest_completed_cursor: 'turn-p1-b1'
    });
    p1.recordEndpointObservation('ide', {
      conversation_id: 'conv-ide-proj-1',
      trusted: true,
      latest_completed_cursor: 'turn-p1-i1'
    });
    p1.markEndpointHandled('ide', { expected_cursor: 'turn-p1-i1' });

    // 为 proj-2 设置状态：Browser 与 IDE 均处于 UNKNOWN
    // （初始未建立信任）

    // 持久化保存
    registry1.saveToFile(file);

    // 模拟应用重启：创建新的 Registry 并从文件重新加载
    const registry2 = createProjectRegistry({ storagePath: file });

    assert.equal(registry2.hasProject('proj-1'), true);
    assert.equal(registry2.hasProject('proj-2'), true);

    const snap1 = registry2.getProject('proj-1').getSnapshot();
    const snap2 = registry2.getProject('proj-2').getSnapshot();

    // 验证 proj-1 恢复效果：Browser 仍为 NEW，IDE 仍为 NO_NEW_RESULT
    assert.equal(snap1.endpoints.browser.result_state, 'NEW');
    assert.equal(snap1.endpoints.browser.latest_completed_cursor, 'turn-p1-b1');
    assert.equal(snap1.endpoints.ide.result_state, 'NO_NEW_RESULT');
    assert.equal(snap1.endpoints.ide.last_handled_cursor, 'turn-p1-i1');

    // 验证 proj-2 独立隔离：两端依然为 UNKNOWN
    assert.equal(snap2.endpoints.browser.result_state, 'UNKNOWN');
    assert.equal(snap2.endpoints.ide.result_state, 'UNKNOWN');
  } finally {
    cleanup();
  }
});

test('[Registry] 2. 重启去重 (Handled Dedup)：重启后已处理完成不回放为 NEW', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg1 = createProjectRegistry({ storagePath: file });
    const core1 = reg1.registerProject({ binding: makeSampleBinding('proj-dedup') });

    core1.recordEndpointObservation('browser', {
      conversation_id: 'conv-browser-proj-dedup',
      trusted: true,
      latest_completed_cursor: 'turn-handled-100'
    });
    core1.markEndpointHandled('browser', { expected_cursor: 'turn-handled-100' });
    assert.equal(core1.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

    reg1.saveToFile(file);

    // 重启加载
    const reg2 = createProjectRegistry({ storagePath: file });
    const core2 = reg2.getProject('proj-dedup');

    // 验证：重启后依然保持 NO_NEW_RESULT，绝对不重新触发为 NEW！
    assert.equal(core2.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
    assert.equal(core2.getSnapshot().endpoints.browser.last_handled_cursor, 'turn-handled-100');
  } finally {
    cleanup();
  }
});

test('[Registry] 3. 重启后推进：下一次真实的完成游标在重启后精确推进一次', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg1 = createProjectRegistry({ storagePath: file });
    const core1 = reg1.registerProject({ binding: makeSampleBinding('proj-advance') });

    core1.recordEndpointObservation('browser', {
      conversation_id: 'conv-browser-proj-advance',
      trusted: true,
      latest_completed_cursor: 'turn-1'
    });
    core1.markEndpointHandled('browser', { expected_cursor: 'turn-1' });
    reg1.saveToFile(file);

    // 重启加载
    const reg2 = createProjectRegistry({ storagePath: file });
    const core2 = reg2.getProject('proj-advance');
    assert.equal(core2.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');

    // 观察到下一次新完成 turn-2
    core2.recordEndpointObservation('browser', {
      conversation_id: 'conv-browser-proj-advance',
      trusted: true,
      latest_completed_cursor: 'turn-2'
    });

    // 精确推进为 NEW 一次
    assert.equal(core2.getSnapshot().endpoints.browser.result_state, 'NEW');
    assert.equal(core2.getSnapshot().endpoints.browser.latest_completed_cursor, 'turn-2');
    assert.equal(core2.getSnapshot().endpoints.browser.last_handled_cursor, 'turn-1');
  } finally {
    cleanup();
  }
});

test('[Registry] 4. 安全端点 Rebind：保持项目身份、递增版本、单端重置且保留未改端点事实', () => {
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding: makeSampleBinding('proj-rebind') });

  // Browser 处于 caught up，IDE 处于 NEW
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-proj-rebind',
    trusted: true,
    latest_completed_cursor: 'b-turn-1'
  });
  core.markEndpointHandled('browser', { expected_cursor: 'b-turn-1' });

  core.recordEndpointObservation('ide', {
    conversation_id: 'conv-ide-proj-rebind',
    trusted: true,
    latest_completed_cursor: 'ide-turn-1'
  });

  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NEW');
  assert.equal(core.getSnapshot().binding.binding_revision, 1);

  // 执行用户显式 Browser 分支 Rebind（切换到分支会话 conv-browser-branch-99）
  const updatedSnap = registry.rebindProjectEndpoint('proj-rebind', {
    endpoint: 'browser',
    identity: {
      provider: 'chatgpt',
      conversation_id: 'conv-browser-branch-99'
    }
  });

  // 1. 项目 ID 保持不变
  assert.equal(updatedSnap.binding.binding_id, 'proj-rebind');
  // 2. 版本号严格递增为 2
  assert.equal(updatedSnap.binding.binding_revision, 2);
  // 3. Browser 会话更新
  assert.equal(updatedSnap.binding.browser.conversation_id, 'conv-browser-branch-99');
  // 4. 重绑端点连续性事实重置为 UNKNOWN，且原因明确为 UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION
  assert.equal(updatedSnap.endpoints.browser.result_state, 'UNKNOWN');
  assert.equal(updatedSnap.endpoints.browser.unknown_reason, 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
  assert.equal(updatedSnap.endpoints.browser.latest_completed_cursor, null);
  // 5. 关键不变性：未重绑的 IDE 端点事实完全保留，NEW 状态未受任何影响！
  assert.equal(updatedSnap.endpoints.ide.result_state, 'NEW');
  assert.equal(updatedSnap.endpoints.ide.latest_completed_cursor, 'ide-turn-1');
});

test('[Registry] 5. 未处理 NEW 替换守卫 (Unhandled NEW Replacement Guard)：默认拒绝替换', () => {
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding: makeSampleBinding('proj-guard') });

  // Browser 处于未处理的 NEW 状态
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-proj-guard',
    trusted: true,
    latest_completed_cursor: 'unhandled-turn-777'
  });
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');

  // 默认尝试替换 Browser 端点：必须被拦截抛错，防止静默丢失 New Result！
  assert.throws(() => {
    registry.rebindProjectEndpoint('proj-guard', {
      endpoint: 'browser',
      identity: { conversation_id: 'new-conv-branch' }
    });
  }, /Cannot replace browser endpoint with unhandled NEW result without explicit confirmation/);

  // 端点依然完好保持在未被替换的状态
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'NEW');
  assert.equal(core.getSnapshot().binding.binding_revision, 1);

  // 当显式提供 allow_discard_unhandled: true 时允许替换，但绝不伪造 mark handled
  const snapshotAfterDiscard = registry.rebindProjectEndpoint('proj-guard', {
    endpoint: 'browser',
    identity: { conversation_id: 'new-conv-branch' },
    allow_discard_unhandled: true
  });

  assert.equal(snapshotAfterDiscard.binding.binding_revision, 2);
  assert.equal(snapshotAfterDiscard.endpoints.browser.result_state, 'UNKNOWN');
  assert.equal(snapshotAfterDiscard.endpoints.browser.unknown_reason, 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
  // 绝不伪造为 unhandled-turn-777 的 handled 游标
  assert.equal(snapshotAfterDiscard.endpoints.browser.last_handled_cursor, null);
});

test('[Registry] 6. 过时版本观察在 Rebind 后失效隔离', () => {
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding: makeSampleBinding('proj-stale') });

  // Rebind 推进至 rev 2（显式确认替换处于初始 UNKNOWN 状态的端点）
  registry.rebindProjectEndpoint('proj-stale', {
    endpoint: 'browser',
    identity: { conversation_id: 'conv-rebound' },
    confirm_replace_unknown: true
  });
  assert.equal(core.getSnapshot().binding.binding_revision, 2);

  // 接收到来自 pre-rebind 的旧版本 (rev 1) 观察
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-rebound',
    trusted: true,
    binding_revision: 1, // 过期版本
    latest_completed_cursor: 'turn-stale'
  });

  // 核心守卫：必须 fail-closed 到 UNKNOWN，拒绝采纳
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
  assert.match(core.getSnapshot().endpoints.browser.unknown_reason, /stale_revision/);
});

test('[Registry] 7. 损坏文件与不支持的 Schema 版本一律 Fail-Closed', () => {
  const { file, dir, cleanup } = createTempStoragePath();
  try {
    // 1. 测试损坏的 JSON
    fs.writeFileSync(file, '{ corrupt-json-content... ', 'utf-8');
    assert.throws(() => {
      const reg = createProjectRegistry();
      reg.loadFromFile(file);
    }, /Corrupt durable registry storage/);

    // 2. 测试不支持的 Schema 版本（未来版本 schema_version: 999）
    fs.writeFileSync(file, JSON.stringify({ schema_version: 999, projects: {} }), 'utf-8');
    assert.throws(() => {
      const reg = createProjectRegistry();
      reg.loadFromFile(file);
    }, /Unsupported registry storage schema_version/);
  } finally {
    cleanup();
  }
});

test('[Registry] 8. 专有受信 Hydration 缝隙证明：不调用 recordEndpointObservation 恢复 handled 游标', () => {
  const binding = makeSampleBinding('proj-hydrate');
  const persistedEndpoints = {
    browser: {
      endpoint: 'browser',
      latest_completed_cursor: 'turn-hydrated-88',
      last_handled_cursor: 'turn-hydrated-88',
      completed_at: '2026-09-15T12:00:00Z',
      continuity: { trusted: true, unknown_reason: null }
    },
    ide: {
      endpoint: 'ide',
      latest_completed_cursor: null,
      last_handled_cursor: null,
      completed_at: null,
      continuity: { trusted: false, unknown_reason: 'initial_unobserved' }
    }
  };

  const reg = createProjectRegistry();
  const core = reg.registerProject({
    binding,
    initial_endpoints: persistedEndpoints
  });

  const snap = core.getSnapshot();
  // 验证反序列化直接还原了底层事实
  assert.equal(snap.endpoints.browser.result_state, 'NO_NEW_RESULT');
  assert.equal(snap.endpoints.browser.latest_completed_cursor, 'turn-hydrated-88');
  assert.equal(snap.endpoints.browser.last_handled_cursor, 'turn-hydrated-88');

  // 证明：live observation 依然被禁止写入 last_handled_cursor！
  core.recordEndpointObservation('browser', {
    conversation_id: 'conv-browser-proj-hydrate',
    trusted: true,
    last_handled_cursor: 'attempted-live-injection'
  });

  assert.equal(core.getSnapshot().endpoints.browser.last_handled_cursor, 'turn-hydrated-88');
});

test('[Registry 回归] 9. 不完整的受信持久化端点绝不能派生为 NO_NEW_RESULT（fail closed 到 UNKNOWN）', () => {
  const binding = makeSampleBinding('proj-incomplete-trusted');
  // 构造恶意/缺失关键游标的持久化事实：声明 trusted: true，但未提供 latest_completed_cursor 与 last_handled_cursor
  const incompleteTrustedEndpoints = {
    browser: {
      endpoint: 'browser',
      // 故意缺失 latest_completed_cursor 与 last_handled_cursor 字段
      continuity: { trusted: true, unknown_reason: null }
    }
  };

  const reg = createProjectRegistry();
  const core = reg.registerProject({
    binding,
    initial_endpoints: incompleteTrustedEndpoints
  });

  const snap = core.getSnapshot();
  // 核心守卫：绝不能因为两游标补 null 相等而派生为 NO_NEW_RESULT！必须 fail closed 到 UNKNOWN！
  assert.equal(snap.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snap.endpoints.browser.unknown_reason, /incomplete_persisted_cursor_ledger/);
  assert.equal(snap.endpoints.browser.continuity.trusted, false);
});

test('[Registry 回归] 10. 持久化端点 slot 不匹配时 fail closed 到 UNKNOWN', () => {
  const binding = makeSampleBinding('proj-slot-mismatch');
  // 放在 browser 槽位的端点事实声明自己是 ide
  const mismatchedEndpoints = {
    browser: {
      endpoint: 'ide', // slot 不符
      latest_completed_cursor: 'turn-1',
      last_handled_cursor: 'turn-1',
      continuity: { trusted: true }
    }
  };

  const reg = createProjectRegistry();
  const core = reg.registerProject({
    binding,
    initial_endpoints: mismatchedEndpoints
  });

  const snap = core.getSnapshot();
  assert.equal(snap.endpoints.browser.result_state, 'UNKNOWN');
  assert.match(snap.endpoints.browser.unknown_reason, /incomplete_persisted_cursor_ledger/);
});

test('[Registry 回归] 11. 外层 key 与内部 binding.binding_id 不一致或重复时被拦截拒载', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg = createProjectRegistry();
    // 1. 测试外层 key 与内部 binding_id 不一致
    const mismatchedPayload = {
      schema_version: 1,
      projects: {
        'outer-key-foo': {
          binding: makeSampleBinding('internal-id-bar')
        }
      }
    };
    fs.writeFileSync(file, JSON.stringify(mismatchedPayload, null, 2), 'utf-8');

    assert.throws(() => {
      reg.loadFromFile(file);
    }, /Durable project key mismatch/);

    // 2. 测试重复内部 binding_id
    const duplicatePayload = {
      schema_version: 1,
      projects: {
        'key-1': { binding: makeSampleBinding('same-id') },
        'key-2': { binding: makeSampleBinding('same-id') }
      }
    };
    fs.writeFileSync(file, JSON.stringify(duplicatePayload, null, 2), 'utf-8');

    assert.throws(() => {
      reg.loadFromFile(file);
    }, /Durable project key mismatch|Duplicate internal binding_id/);
  } finally {
    cleanup();
  }
});

test('[Registry 回归] 12. 多项目加载失败时保持原子性 (All-or-Nothing)，已有内存注册表不被部分破坏', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg = createProjectRegistry();
    // 预先注册一个合法的现有项目
    reg.registerProject({ binding: makeSampleBinding('existing-live-proj') });
    assert.equal(reg.hasProject('existing-live-proj'), true);

    // 构造一个多项目文件：第一个合法，第二个损坏（缺失 binding）
    const partiallyCorruptPayload = {
      schema_version: 1,
      projects: {
        'good-proj-1': { binding: makeSampleBinding('good-proj-1') },
        'bad-proj-2': { corrupt_data: true } // 损坏项目
      }
    };
    fs.writeFileSync(file, JSON.stringify(partiallyCorruptPayload, null, 2), 'utf-8');

    // 执行加载：必须失败
    assert.throws(() => {
      reg.loadFromFile(file);
    }, /Corrupt project data/);

    // 核心断言 (All-or-Nothing)：
    // 加载失败后，已有的内存注册表绝不能被部分清空或替换！'existing-live-proj' 必须完好保留！
    assert.equal(reg.hasProject('existing-live-proj'), true);
    assert.equal(reg.hasProject('good-proj-1'), false);
  } finally {
    cleanup();
  }
});

test('[Registry 回归] 13. UNKNOWN 端点默认阻止 rebind，显式确认方可替换且绝不 mark handled', () => {
  const registry = createProjectRegistry();
  const core = registry.registerProject({ binding: makeSampleBinding('proj-unknown-guard') });

  // 初始端点处于 UNKNOWN 状态
  assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');

  // 1. 默认尝试替换 UNKNOWN 端点：必须抛错阻止，防止静默丢失不确定证据
  assert.throws(() => {
    registry.rebindProjectEndpoint('proj-unknown-guard', {
      endpoint: 'browser',
      identity: { conversation_id: 'conv-new-unknown' }
    });
  }, /Cannot replace browser endpoint in UNKNOWN state without explicit confirmation/);

  // 2. 显式确认后允许替换
  const snapAfterConfirm = registry.rebindProjectEndpoint('proj-unknown-guard', {
    endpoint: 'browser',
    identity: { conversation_id: 'conv-new-unknown' },
    confirm_replace_unknown: true
  });

  // 3. 验证关键不变性：新端点进入规范 UNKNOWN 状态，绝不伪造 mark handled
  assert.equal(snapAfterConfirm.endpoints.browser.result_state, 'UNKNOWN');
  assert.equal(snapAfterConfirm.endpoints.browser.unknown_reason, 'UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION');
  assert.equal(snapAfterConfirm.endpoints.browser.last_handled_cursor, null);
  assert.equal(snapAfterConfirm.endpoints.browser.latest_completed_cursor, null);
  assert.equal(snapAfterConfirm.binding.binding_revision, 2);
});

test('[Registry 回归] 14. 字符串 "true"、对象等 truthy 值绝不能建立 trusted restore', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg = createProjectRegistry();
    const malformedPayload = {
      schema_version: 1,
      saved_at: new Date().toISOString(),
      projects: {
        'proj-truthy-test': {
          binding: makeSampleBinding('proj-truthy-test'),
          endpoints: {
            browser: {
              endpoint: 'browser',
              latest_completed_cursor: 'turn-1',
              last_handled_cursor: 'turn-1',
              continuity: { trusted: 'true' } // 字符串 "true" 伪造信任
            },
            ide: {
              endpoint: 'ide',
              latest_completed_cursor: 'turn-1',
              last_handled_cursor: 'turn-1',
              continuity: { trusted: { malicious: true } } // truthy 对象伪造信任
            }
          }
        }
      }
    };
    fs.writeFileSync(file, JSON.stringify(malformedPayload, null, 2), 'utf-8');

    reg.loadFromFile(file);
    const core = reg.getProject('proj-truthy-test');

    // 核心守卫：非严格布尔值必须 fail-closed 为 UNKNOWN，绝不可派生为 NO_NEW_RESULT
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'UNKNOWN');
  } finally {
    cleanup();
  }
});

test('[Registry 回归] 15. 拒绝不可能的游标账本 (latest=null 且 handled!=null)', () => {
  const { file, cleanup } = createTempStoragePath();
  try {
    const reg = createProjectRegistry();
    const impossiblePayload = {
      schema_version: 1,
      saved_at: new Date().toISOString(),
      projects: {
        'proj-impossible-test': {
          binding: makeSampleBinding('proj-impossible-test'),
          endpoints: {
            browser: {
              endpoint: 'browser',
              latest_completed_cursor: null,
              last_handled_cursor: 'turn-handled-1',
              continuity: { trusted: true } // 声明受信但游标不可能
            },
            ide: {
              endpoint: 'ide',
              latest_completed_cursor: null,
              last_handled_cursor: null,
              continuity: { trusted: true }
            }
          }
        }
      }
    };
    fs.writeFileSync(file, JSON.stringify(impossiblePayload, null, 2), 'utf-8');

    reg.loadFromFile(file);
    const core = reg.getProject('proj-impossible-test');

    // 核心守卫：latest=null 且 handled!=null 必须 fail-closed 到 UNKNOWN，绝不可派生为 NO_NEW_RESULT
    assert.equal(core.getSnapshot().endpoints.browser.result_state, 'UNKNOWN');
    assert.match(core.getSnapshot().endpoints.browser.unknown_reason, /impossible_persisted_cursor_ledger/);

    // ide 端点作为合法的 latest=null, handled=null 则正确派生为 NO_NEW_RESULT
    assert.equal(core.getSnapshot().endpoints.ide.result_state, 'NO_NEW_RESULT');
  } finally {
    cleanup();
  }
});

test('[Registry 回归] 16. 合法游标账本组合与纯函数派生覆盖', () => {
  // 1. latest=null, handled=null => NO_NEW_RESULT (trusted caught-up / no known completion)
  assert.equal(deriveEndpointResult({
    continuity: { trusted: true },
    latest_completed_cursor: null,
    last_handled_cursor: null
  }), 'NO_NEW_RESULT');

  // 2. latest!=null, handled=null => NEW
  assert.equal(deriveEndpointResult({
    continuity: { trusted: true },
    latest_completed_cursor: 'turn-1',
    last_handled_cursor: null
  }), 'NEW');

  // 3. latest==handled => NO_NEW_RESULT
  assert.equal(deriveEndpointResult({
    continuity: { trusted: true },
    latest_completed_cursor: 'turn-1',
    last_handled_cursor: 'turn-1'
  }), 'NO_NEW_RESULT');

  // 4. latest!=handled => NEW
  assert.equal(deriveEndpointResult({
    continuity: { trusted: true },
    latest_completed_cursor: 'turn-2',
    last_handled_cursor: 'turn-1'
  }), 'NEW');

  // 5. impossible latest=null, handled!=null => UNKNOWN
  assert.equal(deriveEndpointResult({
    continuity: { trusted: true },
    latest_completed_cursor: null,
    last_handled_cursor: 'turn-1'
  }), 'UNKNOWN');
});
