/**
 * TDD Seam 1: Server startup / loopback bind seam 测试
 * 验证 Issue #28 规范：
 * 1. default loopback startup remains valid;
 * 2. accidental non-loopback bind fails closed unless an explicitly designed security mode exists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../../src/surface/surface-server.js';
import { isLoopbackHost } from '../../src/surface/surface-security.js';

describe('TDD Seam 1: Server startup / loopback bind seam', () => {
  it('1. isLoopbackHost 正确识别环回地址与非环回地址', () => {
    // 合法 loopback
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('127.0.0.2'), true);
    assert.equal(isLoopbackHost('127.1.2.3'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('[::1]'), true);

    // 非 loopback 必须为 false
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('192.168.1.1'), false);
    assert.equal(isLoopbackHost('10.0.0.1'), false);
    assert.equal(isLoopbackHost('example.com'), false);
    assert.equal(isLoopbackHost('::'), false);
    assert.equal(isLoopbackHost(''), false);
    assert.equal(isLoopbackHost(null), false);
  });

  it('2. 默认参数 (127.0.0.1) 启动服务成功并监听环回端口', async () => {
    const registry = createProjectRegistry();
    const server = await startStatusSurfaceServer({ registry, port: 0 });
    try {
      assert.ok(server.port > 0);
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.close();
    }
  });

  it('3. 显式 localhost 启动服务成功', async () => {
    const registry = createProjectRegistry();
    const server = await startStatusSurfaceServer({ registry, port: 0, host: 'localhost' });
    try {
      assert.ok(server.port > 0);
      assert.match(server.url, /^http:\/\/localhost:\d+$/);
    } finally {
      await server.close();
    }
  });

  it('4. 传入非环回 host (0.0.0.0) 必须 Fail-Closed 抛出异常并拒绝启动', async () => {
    const registry = createProjectRegistry();
    await assert.rejects(
      async () => {
        await startStatusSurfaceServer({ registry, port: 0, host: '0.0.0.0' });
      },
      (err) => {
        assert.match(err.message, /NON_LOOPBACK_BIND_REFUSED/);
        return true;
      }
    );
  });

  it('5. 传入非环回局域网 host (192.168.1.50) 必须 Fail-Closed 抛出异常', async () => {
    const registry = createProjectRegistry();
    await assert.rejects(
      async () => {
        await startStatusSurfaceServer({ registry, port: 0, host: '192.168.1.50' });
      },
      (err) => {
        assert.match(err.message, /NON_LOOPBACK_BIND_REFUSED/);
        return true;
      }
    );
  });

  it('6. 传入 IPv6 全零地址 (::) 必须 Fail-Closed 抛出异常', async () => {
    const registry = createProjectRegistry();
    await assert.rejects(
      async () => {
        await startStatusSurfaceServer({ registry, port: 0, host: '::' });
      },
      (err) => {
        assert.match(err.message, /NON_LOOPBACK_BIND_REFUSED/);
        return true;
      }
    );
  });

  it('7. Surface 以 "::1" 启动时，server.url 必须为有效 bracketed URL 且直接请求成功', async () => {
    const registry = createProjectRegistry();
    const server = await startStatusSurfaceServer({ registry, port: 0, host: '::1' });
    try {
      assert.ok(server.port > 0);
      // server.url 必须为合法有效带方括号的 IPv6 URL: http://[::1]:<port>
      assert.match(server.url, /^http:\/\/\[::1\]:\d+$/);

      // 直接使用 server.url 发起请求并成功，验证 server.url 的原生契约
      const res = await fetch(server.url);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('Rally'));
    } finally {
      await server.close();
    }
  });
});
