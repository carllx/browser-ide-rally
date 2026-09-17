/**
 * 本地状态表面启动配置单元与回归测试 (Surface Startup Regression Tests)
 * 验证 Issue #17 修复：禁止对不存在的 --storage 静默伪造 demo 数据，保障生产 Fail-Closed 原则
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, initializeStartupRegistry } from '../../scripts/start-surface.mjs';

describe('Surface Startup 启动配置与 Fail-Closed 回归测试', () => {
  it('1. 参数解析：正确解析 --port、--storage 与显式 --demo 标志', () => {
    const opts = parseArgs(['--port', '8080', '--storage', 'some-path.json', '--demo']);
    assert.equal(opts.port, 8080);
    assert.match(opts.storage, /some-path\.json$/);
    assert.equal(opts.demo, true);

    const defaultOpts = parseArgs([]);
    assert.equal(defaultOpts.port, 3123);
    assert.equal(defaultOpts.storage, null);
    assert.equal(defaultOpts.demo, false);
  });

  it('2. 显式指定不存在的 --storage 文件时严格 Fail-Closed，绝不启动 demo 亦不持久化 demo 事实', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-startup-test-'));
    const nonExistentFile = path.join(tmpDir, 'nonexistent-registry.json');

    try {
      assert.equal(fs.existsSync(nonExistentFile), false);

      // 必须抛出明确错误并拒绝启动
      assert.throws(() => {
        initializeStartupRegistry({ storage: nonExistentFile, demo: false });
      }, /Storage file ".*" does not exist\. Failing closed/);

      // 验证未在此路径创建任何持久化文件
      assert.equal(fs.existsSync(nonExistentFile), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. 显式 --demo 模式在内存中装配演示事实，不绑定持久化路径', () => {
    const reg = initializeStartupRegistry({ demo: true });
    const projects = reg.listProjects();

    assert.equal(projects.length >= 3, true);
    // 包含预期演示项目
    const ids = projects.map(p => p.binding.binding_id);
    assert.equal(ids.includes('rally-core-service'), true);
    assert.equal(ids.includes('rally-staging-service'), true);
    assert.equal(ids.includes('rally-production-gate'), true);
  });

  it('4. 默认生产模式启动干净的空注册表，绝不伪造任何项目与状态事实', () => {
    const reg = initializeStartupRegistry({ storage: null, demo: false });
    const projects = reg.listProjects();

    assert.equal(projects.length, 0);
  });

  it('5. 禁止同时指定已存在的 --storage 文件与显式 --demo 标志，防止污染生产存储', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-storage-conflict-'));
    const dummyFile = path.join(tmpDir, 'existing-reg.json');
    fs.writeFileSync(dummyFile, JSON.stringify({ schema_version: 2, saved_at: new Date().toISOString(), projects: {} }));

    try {
      assert.throws(() => {
        initializeStartupRegistry({ storage: dummyFile, demo: true });
      }, /Cannot combine explicit --demo with an existing --storage file/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
