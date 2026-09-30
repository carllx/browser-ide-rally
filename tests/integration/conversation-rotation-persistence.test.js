/**
 * Conversation Rotation Persistence & Schema Migration Integration Test
 * 
 * 覆盖 Issue #41 关键持久化与数据迁移契约 (Browser Review 5907052282):
 * 1. 物理隔离与重启恢复：重启后活跃端点与退役端点代际严格隔离；
 * 2. Schema v3 规范存储与 Round-trip 读写；
 * 3. Schema v1 遗留数据平滑迁移（缺省赋 []）；
 * 4. 旧 Schema v2 遗留数据平滑迁移（无 retired_generations 时缺省赋 []）；
 * 5. Candidate-era Schema v2（已包含合法退役历史）无损继承迁移；
 * 6. 不受支持的 Schema 版本（如 v0, v4, v99）严格 Fail-Closed 抛错拦截；
 * 7. 损坏退役代际（无效 role, 非法 revision, 缺失 identity/fact, 角色失配等）严格 Fail-Closed 抛错。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

function createTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-issue41-persist-test-'));
  const file = path.join(dir, 'registry.json');
  return {
    dir,
    file,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  };
}

function makeSampleProject(id = 'proj-persist') {
  return createBinding({
    binding_id: id,
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-br-init',
      branch: 'main'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-init',
        workspace_identity: '/ws/persist',
        repository_identity: 'github.com/org/persist'
      }
    ]
  });
}

describe('Issue #41: 退役代际持久化、Schema v3 升级与 Fail-Closed 水合校验', () => {
  test('1. 持久化与重启恢复：完整保留活跃端点与退役端点代际的物理隔离', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const reg1 = createProjectRegistry({ storagePath: file });
      const core1 = reg1.registerProject({ binding: makeSampleProject('proj-test-1') });

      // 产生 NEW 事实后轮换两次
      core1.recordEndpointObservation('ide-primary', {
        trusted: true,
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-init',
        latest_completed_cursor: 'cursor-gen1',
        completed_at: new Date().toISOString()
      });

      reg1.rebindProjectEndpoint('proj-test-1', {
        endpoint: 'ide-primary',
        identity: {
          conversation_id: 'conv-ide-gen2',
          workspace_identity: '/ws/persist',
          repository_identity: 'github.com/org/persist'
        }
      });

      reg1.rebindProjectEndpoint('proj-test-1', {
        endpoint: 'ide-primary',
        identity: {
          conversation_id: 'conv-ide-gen3',
          workspace_identity: '/ws/persist',
          repository_identity: 'github.com/org/persist'
        }
      });

      assert.equal(core1.getRetiredGenerations().length, 2);
      reg1.saveToFile(file);

      // 从磁盘重新加载
      const reg2 = createProjectRegistry({ storagePath: file });
      const core2 = reg2.getProject('proj-test-1');
      const snap2 = core2.getSnapshot();

      assert.equal(snap2.binding.binding_revision, 3);
      assert.equal(snap2.binding.ide.conversation_id, 'conv-ide-gen3');
      assert.equal(snap2.endpoints.ide.result_state, 'UNKNOWN');

      // 验证恢复出来的退役代际账本
      const retiredLoaded = core2.getRetiredGenerations();
      assert.equal(retiredLoaded.length, 2);
      assert.equal(retiredLoaded[0].identity.conversation_id, 'conv-ide-init');
      assert.equal(retiredLoaded[0].endpoint_fact.latest_completed_cursor, 'cursor-gen1');
      assert.equal(retiredLoaded[1].identity.conversation_id, 'conv-ide-gen2');
    } finally {
      cleanup();
    }
  });

  test('2. Schema v3 规范存储与 Round-trip 验证', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const reg = createProjectRegistry({ storagePath: file });
      reg.registerProject({ binding: makeSampleProject('proj-v3-roundtrip') });
      reg.saveToFile(file);

      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(raw.schema_version, 3, '落盘格式必须为 schema_version: 3');
      assert.ok(raw.projects['proj-v3-roundtrip'], '包含项目数据');
      assert.deepEqual(raw.projects['proj-v3-roundtrip'].retired_generations, [], '初始退役代际为空数组');

      const reloadedReg = createProjectRegistry({ storagePath: file });
      assert.ok(reloadedReg.hasProject('proj-v3-roundtrip'));
      assert.equal(reloadedReg.getProject('proj-v3-roundtrip').getRetiredGenerations().length, 0);
    } finally {
      cleanup();
    }
  });

  test('3. Schema v1 遗留数据迁移：自动平滑升级为 v3 且退役代际初始化为空', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const v1Data = {
        schema_version: 1,
        active_project_id: 'proj-legacy-v1',
        projects: {
          'proj-legacy-v1': {
            binding: makeSampleProject('proj-legacy-v1'),
            endpoints: {
              browser: null,
              ide: null
            },
            human_intervention: { active: false, reason: null, updated_at: new Date().toISOString() },
            actions: [],
            updated_at: new Date().toISOString()
          }
        }
      };
      fs.writeFileSync(file, JSON.stringify(v1Data, null, 2), 'utf8');

      const reg = createProjectRegistry({ storagePath: file });
      assert.ok(reg.hasProject('proj-legacy-v1'));
      const core = reg.getProject('proj-legacy-v1');
      assert.deepEqual(core.getRetiredGenerations(), []);

      // 保存后自动写为 Schema v3
      reg.saveToFile(file);
      const updatedJson = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(updatedJson.schema_version, 3);
      assert.ok(Array.isArray(updatedJson.projects['proj-legacy-v1'].retired_generations));
    } finally {
      cleanup();
    }
  });

  test('4. 旧版 Schema v2 遗留数据迁移：未包含 retired_generations 字段时平滑补齐为 []', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const oldV2Data = {
        schema_version: 2,
        active_project_id: 'proj-old-v2',
        projects: {
          'proj-old-v2': {
            binding: makeSampleProject('proj-old-v2'),
            browser: null,
            ide_endpoints: {},
            human_intervention: { active: false, reason: null, updated_at: new Date().toISOString() },
            actions: [],
            ordering_evidence: null,
            updated_at: new Date().toISOString()
            // 注意：缺少 retired_generations 字段
          }
        }
      };
      fs.writeFileSync(file, JSON.stringify(oldV2Data, null, 2), 'utf8');

      const reg = createProjectRegistry({ storagePath: file });
      assert.ok(reg.hasProject('proj-old-v2'));
      assert.deepEqual(reg.getProject('proj-old-v2').getRetiredGenerations(), []);

      reg.saveToFile(file);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(raw.schema_version, 3);
      assert.deepEqual(raw.projects['proj-old-v2'].retired_generations, []);
    } finally {
      cleanup();
    }
  });

  test('5. Candidate-era Schema v2 迁移：无损保留既有的合法退役代际历史（包含遗留 Browser 代际与 IDE 代际）', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const sampleProj = makeSampleProject('proj-candidate-v2');
      const now = new Date().toISOString();
      const candidateV2Data = {
        schema_version: 2,
        active_project_id: 'proj-candidate-v2',
        projects: {
          'proj-candidate-v2': {
            binding: sampleProj,
            browser: null,
            ide_endpoints: {},
            retired_generations: [
              {
                role: 'ide',
                endpoint_id: 'ide-primary',
                endpoint_revision: 1,
                retired_at: now,
                reason: 'conversation_rotation',
                identity: {
                  conversation_id: 'conv-real-candidate-era-1',
                  workspace_identity: '/ws/persist',
                  repository_identity: 'github.com/org/persist'
                },
                endpoint_fact: {
                  endpoint: 'ide-primary',
                  role: 'ide',
                  endpoint_revision: 1,
                  latest_completed_cursor: 'cursor-candidate-1',
                  last_handled_cursor: null,
                  completed_at: now,
                  updated_at: now,
                  continuity: { trusted: true, unknown_reason: null }
                }
              },
              {
                role: 'browser',
                endpoint_id: 'browser',
                endpoint_revision: 1,
                retired_at: now,
                reason: 'conversation_rotation',
                identity: {
                  conversation_id: 'conv-browser-cand-1',
                  branch: 'feat-browser-cand',
                  provider: null // 真实 candidate-era 遗留历史：未提供或为 null，绝不捏造成 'chatgpt'
                },
                endpoint_fact: {
                  endpoint: 'browser',
                  role: 'browser',
                  endpoint_revision: 1,
                  latest_completed_cursor: 'cursor-browser-1',
                  last_handled_cursor: null,
                  completed_at: now,
                  updated_at: now,
                  continuity: { trusted: true, unknown_reason: null }
                }
              }
            ],
            human_intervention: { active: false, reason: null, updated_at: now },
            actions: [],
            ordering_evidence: null,
            updated_at: now
          }
        }
      };
      fs.writeFileSync(file, JSON.stringify(candidateV2Data, null, 2), 'utf8');

      const reg = createProjectRegistry({ storagePath: file });
      const core = reg.getProject('proj-candidate-v2');
      const retired = core.getRetiredGenerations();
      assert.equal(retired.length, 2);
      // IDE 代际
      assert.equal(retired[0].identity.conversation_id, 'conv-real-candidate-era-1');
      assert.equal(retired[0].endpoint_fact.latest_completed_cursor, 'cursor-candidate-1');
      assert.equal(retired[0].endpoint_fact.updated_at, now);

      // Browser 代际：保持 provider 为 null（保留有界不确定性），绝不假造 'chatgpt'
      assert.equal(retired[1].identity.conversation_id, 'conv-browser-cand-1');
      assert.equal(retired[1].identity.provider, null, '遗留 Browser 代际必须保持 provider: null，绝不制造虚假事实');
      assert.equal(retired[1].identity.branch, 'feat-browser-cand');
      assert.equal(retired[1].endpoint_fact.latest_completed_cursor, 'cursor-browser-1');
      assert.equal(retired[1].endpoint_fact.updated_at, now);

      reg.saveToFile(file);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(raw.schema_version, 3);
      assert.equal(raw.projects['proj-candidate-v2'].retired_generations.length, 2);
      assert.equal(
        raw.projects['proj-candidate-v2'].retired_generations[0].identity.conversation_id,
        'conv-real-candidate-era-1'
      );
      assert.equal(
        raw.projects['proj-candidate-v2'].retired_generations[1].identity.provider,
        null
      );
    } finally {
      cleanup();
    }
  });

  test('6. 不受支持的 Schema 版本（如 0, 4, 99）严格 Fail-Closed 抛错拒载', () => {
    const { file, cleanup } = createTempStorage();
    try {
      for (const unsupportedVer of [0, 4, 99, 'unsupported']) {
        const invalidData = {
          schema_version: unsupportedVer,
          projects: {}
        };
        fs.writeFileSync(file, JSON.stringify(invalidData), 'utf8');
        assert.throws(
          () => createProjectRegistry({ storagePath: file }),
          /UNSUPPORTED_SCHEMA_VERSION/,
          `Schema version ${unsupportedVer} 必须严格抛出 UNSUPPORTED_SCHEMA_VERSION 错误`
        );
      }
    } finally {
      cleanup();
    }
  });

  test('7. 损坏的退役代际账本严格 Fail-Closed：绝不静默填充默认值或容忍畸形数据', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const now = new Date().toISOString();
      const validEntry = {
        role: 'ide',
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        retired_at: now,
        reason: 'conversation_rotation',
        identity: {
          conversation_id: 'conv-valid',
          workspace_identity: '/ws/persist',
          repository_identity: 'github.com/org/persist'
        },
        endpoint_fact: {
          endpoint: 'ide-primary',
          role: 'ide',
          endpoint_revision: 1,
          latest_completed_cursor: 'cursor-1',
          last_handled_cursor: null,
          completed_at: now,
          updated_at: now,
          continuity: { trusted: true, unknown_reason: null }
        }
      };

      const corruptCases = [
        { desc: '非法 role', mutate: e => ({ ...e, role: 'invalid_role' }) },
        { desc: '非正整数 revision', mutate: e => ({ ...e, endpoint_revision: 0 }) },
        { desc: '负数 revision', mutate: e => ({ ...e, endpoint_revision: -1 }) },
        { desc: '缺少 identity', mutate: e => ({ ...e, identity: null }) },
        { desc: '缺少 identity.conversation_id', mutate: e => ({ ...e, identity: { workspace_identity: '/ws' } }) },
        { desc: 'IDE 缺少 workspace_identity', mutate: e => ({ ...e, identity: { conversation_id: 'conv-1', repository_identity: 'r1' } }) },
        { desc: 'IDE workspace_identity 为空串', mutate: e => ({ ...e, identity: { conversation_id: 'conv-1', workspace_identity: '   ', repository_identity: 'r1' } }) },
        { desc: 'IDE 缺少 repository_identity', mutate: e => ({ ...e, identity: { conversation_id: 'conv-1', workspace_identity: '/ws' } }) },
        { desc: 'IDE 携带非法 branch', mutate: e => ({ ...e, identity: { ...e.identity, branch: 'feat' } }) },
        { desc: 'Browser provider 为非法类型(数字)', mutate: e => ({ ...e, role: 'browser', endpoint_id: 'browser', identity: { conversation_id: 'conv-1', provider: 123 }, endpoint_fact: { ...e.endpoint_fact, role: 'browser', endpoint: 'browser' } }) },
        { desc: 'Browser provider 为非法空串', mutate: e => ({ ...e, role: 'browser', endpoint_id: 'browser', identity: { conversation_id: 'conv-1', provider: '   ' }, endpoint_fact: { ...e.endpoint_fact, role: 'browser', endpoint: 'browser' } }) },
        { desc: 'Browser 携带非法 workspace_identity', mutate: e => ({ ...e, role: 'browser', endpoint_id: 'browser', identity: { conversation_id: 'conv-1', provider: 'chatgpt', workspace_identity: '/ws' }, endpoint_fact: { ...e.endpoint_fact, role: 'browser', endpoint: 'browser' } }) },
        { desc: 'Browser branch 为非法类型', mutate: e => ({ ...e, role: 'browser', endpoint_id: 'browser', identity: { conversation_id: 'conv-1', provider: 'chatgpt', branch: 123 }, endpoint_fact: { ...e.endpoint_fact, role: 'browser', endpoint: 'browser' } }) },
        { desc: '缺少 endpoint_fact', mutate: e => ({ ...e, endpoint_fact: null }) },
        { desc: '缺少 endpoint_fact.continuity', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, continuity: null } }) },
        { desc: 'continuity.trusted 不是布尔值', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, continuity: { trusted: 'true' } } }) },
        { desc: 'role 与 endpoint_fact.role 不匹配', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, role: 'browser' } }) },
        { desc: 'endpoint_revision 与 endpoint_fact.endpoint_revision 不匹配', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, endpoint_revision: 2 } }) },
        { desc: 'endpoint_id 与 endpoint_fact.endpoint 不匹配', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, endpoint: 'ide-secondary' } }) },
        { desc: 'retired_at 非法时间戳', mutate: e => ({ ...e, retired_at: 'not-a-timestamp' }) },
        { desc: 'completed_at 非法时间戳', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, completed_at: 'bad-date' } }) },
        { desc: '缺少 endpoint_fact.updated_at', mutate: e => { const copy = { ...e, endpoint_fact: { ...e.endpoint_fact } }; delete copy.endpoint_fact.updated_at; return copy; } },
        { desc: 'endpoint_fact.updated_at 为 null', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, updated_at: null } }) },
        { desc: 'updated_at 非法时间戳', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, updated_at: 'bad-date' } }) },
        { desc: 'latest_completed_result cursor 不匹配', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, latest_completed_result: { cursor: 'diff-cursor', result_ref: 'ref', text: 't', captured_at: now } } }) },
        { desc: 'latest_completed_result 缺少 result_ref', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, latest_completed_result: { cursor: 'cursor-1', result_ref: '', text: 't', captured_at: now } } }) },
        { desc: 'latest_completed_result captured_at 非法', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, latest_completed_result: { cursor: 'cursor-1', result_ref: 'r', text: 't', captured_at: 'invalid' } } }) },
        { desc: 'cursor 为 null 但携带 latest_completed_result', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, latest_completed_cursor: null, latest_completed_result: { cursor: 'c', result_ref: 'r', text: 't', captured_at: now } } }) },
        { desc: '不可能账本 (latest 为空但 handled 非空)', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, latest_completed_cursor: null, last_handled_cursor: 'cur-1' } }) },
        { desc: '自相矛盾的状态 (真实为 NEW 但声明为 UNKNOWN)', mutate: e => ({ ...e, endpoint_fact: { ...e.endpoint_fact, result_state: 'UNKNOWN' } }) }
      ];

      for (const { desc, mutate } of corruptCases) {
        const corruptEntry = mutate(validEntry);
        const badData = {
          schema_version: 3,
          projects: {
            'proj-corrupt': {
              binding: makeSampleProject('proj-corrupt'),
              retired_generations: [corruptEntry]
            }
          }
        };
        fs.writeFileSync(file, JSON.stringify(badData), 'utf8');

        assert.throws(
          () => createProjectRegistry({ storagePath: file }),
          err => {
            return (
              err.message.includes('INVALID_RETIRED_GENERATION') ||
              err.message.includes('Corrupt retired generation') ||
              err.message.includes('Failed to load project')
            );
          },
          `损坏场景 [${desc}] 必须严格 Fail-Closed 抛错拒绝加载`
        );
      }
    } finally {
      cleanup();
    }
  });

  test('8. 回归验证：退役的 NEW 证据绝不能携带自相矛盾的 UNKNOWN 状态，且 raw facts 不伪造持久化 result_state', () => {
    const { file, cleanup } = createTempStorage();
    try {
      const reg1 = createProjectRegistry({ storagePath: file });
      const core1 = reg1.registerProject({ binding: makeSampleProject('proj-new-retired') });

      // 制造一个明确的受信 NEW 事实并轮换
      core1.recordEndpointObservation('ide-primary', {
        trusted: true,
        endpoint_id: 'ide-primary',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-init',
        latest_completed_cursor: 'cursor-new-100',
        completed_at: new Date().toISOString()
      });
      assert.equal(core1.getSnapshot().endpoints.ide.result_state, 'NEW');

      reg1.rebindProjectEndpoint('proj-new-retired', {
        endpoint: 'ide-primary',
        identity: {
          conversation_id: 'conv-ide-next',
          workspace_identity: '/ws/persist',
          repository_identity: 'github.com/org/persist'
        }
      });

      reg1.saveToFile(file);

      // 读取磁盘 JSON 验证：
      // 1. 退役代际的 endpoint_fact 保持原始规范结构，绝不伪造硬编码制造 result_state: "UNKNOWN"
      const rawData = JSON.parse(fs.readFileSync(file, 'utf8'));
      const retiredEntry = rawData.projects['proj-new-retired'].retired_generations[0];
      assert.ok(retiredEntry);
      assert.equal(retiredEntry.endpoint_fact.latest_completed_cursor, 'cursor-new-100');
      assert.notEqual(retiredEntry.endpoint_fact.result_state, 'UNKNOWN', '退役 NEW 证据绝不得硬造为 UNKNOWN');

      // 2. 重新加载，验证依然可正常从磁盘还原
      const reg2 = createProjectRegistry({ storagePath: file });
      const core2 = reg2.getProject('proj-new-retired');
      assert.equal(core2.getRetiredGenerations().length, 1);
      assert.equal(core2.getRetiredGenerations()[0].endpoint_fact.latest_completed_cursor, 'cursor-new-100');
    } finally {
      cleanup();
    }
  });
});
