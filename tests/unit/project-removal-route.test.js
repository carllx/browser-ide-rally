import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';
import { createStatusSurfaceRequestHandler } from '../../src/surface/surface-server.js';
import { isMutationRoute } from '../../src/surface/surface-security.js';

function makeTestBinding(id, rev = 1) {
  return createBinding({
    binding_id: id,
    binding_revision: rev,
    display_name: `项目 ${id}`,
    browser: {
      provider: 'chatgpt',
      conversation_id: `conv-browser-${id}`,
      branch: 'main'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: `conv-ide-${id}`,
        workspace_identity: `/tmp/ws-${id}`,
        repository_identity: `repo-${id}`
      }
    ]
  });
}

function requestJson(server, { method = 'POST', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const reqHeaders = {
      Host: `127.0.0.1:${port}`,
      ...headers
    };

    const payload = body !== null ? JSON.stringify(body) : null;
    if (payload !== null && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed,
          raw
        });
      });
    });

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

test('Seam 2.1: isMutationRoute 严格包含 /api/projects/:bindingId/remove', () => {
  assert.equal(isMutationRoute('/api/projects/proj-1/remove'), true);
  assert.equal(isMutationRoute('/api/projects/sample-abc/remove'), true);
  assert.equal(isMutationRoute('/api/projects/proj-1/remove/extra'), false);
  assert.equal(isMutationRoute('/api/projects/remove'), false);
});

test('Seam 2.2: 安全门禁拦截 (Session Token, Content-Type, Origin, Host)', async () => {
  const registry = createProjectRegistry();
  registry.registerProject({ binding: makeTestBinding('proj-sec') });

  const sessionToken = 'secret-session-token-12345678901234567890';
  let server;
  let serverUrl;

  await new Promise((resolve) => {
    const handler = createStatusSurfaceRequestHandler({
      registry,
      sessionToken,
      serverContext: () => ({ expectedHost: '127.0.0.1', expectedPort: server.address().port })
    });
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  try {
    const port = server.address().port;

    // 1. 缺少 Session Token => 403
    const resNoToken = await requestJson(server, {
      path: '/api/projects/proj-sec/remove',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`
      },
      body: { expected_binding_revision: 1 }
    });
    assert.equal(resNoToken.statusCode, 403);
    assert.equal(registry.hasProject('proj-sec'), true);

    // 2. 错误 Session Token => 403
    const resBadToken = await requestJson(server, {
      path: '/api/projects/proj-sec/remove',
      headers: {
        'Content-Type': 'application/json',
        'X-Rally-Session-Token': 'wrong-token-invalid',
        Origin: `http://127.0.0.1:${port}`
      },
      body: { expected_binding_revision: 1 }
    });
    assert.equal(resBadToken.statusCode, 403);
    assert.equal(registry.hasProject('proj-sec'), true);

    // 3. 非 application/json Content-Type => 415
    const resBadCt = await requestJson(server, {
      path: '/api/projects/proj-sec/remove',
      headers: {
        'Content-Type': 'text/plain',
        'X-Rally-Session-Token': sessionToken,
        Origin: `http://127.0.0.1:${port}`
      },
      body: { expected_binding_revision: 1 }
    });
    assert.equal(resBadCt.statusCode, 415);
    assert.equal(registry.hasProject('proj-sec'), true);

    // 4. 跨源 Origin 伪造 => 403
    const resBadOrigin = await requestJson(server, {
      path: '/api/projects/proj-sec/remove',
      headers: {
        'Content-Type': 'application/json',
        'X-Rally-Session-Token': sessionToken,
        Origin: 'http://malicious-attacker.com'
      },
      body: { expected_binding_revision: 1 }
    });
    assert.equal(resBadOrigin.statusCode, 403);
    assert.equal(registry.hasProject('proj-sec'), true);
  } finally {
    server.close();
  }
});

test('Seam 2.3: 业务校验与 Zero Mutation (过期 revision、缺失 revision、未知项目)', async () => {
  const registry = createProjectRegistry();
  registry.registerProject({ binding: makeTestBinding('proj-biz', 2) });
  registry.registerProject({ binding: makeTestBinding('proj-sibling', 1) });

  const sessionToken = 'valid-token-for-biz-test-1234567890';
  let server;

  await new Promise((resolve) => {
    const handler = createStatusSurfaceRequestHandler({
      registry,
      sessionToken,
      serverContext: () => ({ expectedHost: '127.0.0.1', expectedPort: server.address().port })
    });
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    const authHeaders = {
      'Content-Type': 'application/json',
      'X-Rally-Session-Token': sessionToken,
      Origin: `http://127.0.0.1:${port}`
    };

    // 1. 未知项目 => 404
    const resNotFound = await requestJson(server, {
      path: '/api/projects/non-existent-proj/remove',
      headers: authHeaders,
      body: { expected_binding_revision: 1 }
    });
    assert.equal(resNotFound.statusCode, 404);
    assert.equal(resNotFound.data.success, false);

    // 2. 缺失 expected_binding_revision => 409 / 400
    const resMissingRev = await requestJson(server, {
      path: '/api/projects/proj-biz/remove',
      headers: authHeaders,
      body: {}
    });
    assert.ok(resMissingRev.statusCode === 400 || resMissingRev.statusCode === 409);
    assert.equal(resMissingRev.data.success, false);
    assert.equal(registry.hasProject('proj-biz'), true);

    // 3. 过期 expected_binding_revision (实际 2, 期望 1) => 409 (BLOCKED)
    const resStaleRev = await requestJson(server, {
      path: '/api/projects/proj-biz/remove',
      headers: authHeaders,
      body: { expected_binding_revision: 1 }
    });
    assert.equal(resStaleRev.statusCode, 409);
    assert.equal(resStaleRev.data.success, false);
    assert.equal(resStaleRev.data.stage, 'BLOCKED');
    // 确保 zero mutation
    assert.equal(registry.hasProject('proj-biz'), true);
    assert.equal(registry.hasProject('proj-sibling'), true);
  } finally {
    server.close();
  }
});

test('Seam 2.4: 正常请求成功移出项目，返回人类后果语言且兄弟项目完整', async () => {
  const registry = createProjectRegistry();
  registry.registerProject({ binding: makeTestBinding('proj-remove-me', 1) });
  registry.registerProject({ binding: makeTestBinding('proj-stay-here', 1) });

  const sessionToken = 'valid-token-for-success-test-12345678';
  let server;

  await new Promise((resolve) => {
    const handler = createStatusSurfaceRequestHandler({
      registry,
      sessionToken,
      serverContext: () => ({ expectedHost: '127.0.0.1', expectedPort: server.address().port })
    });
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    const authHeaders = {
      'Content-Type': 'application/json',
      'X-Rally-Session-Token': sessionToken,
      Origin: `http://127.0.0.1:${port}`
    };

    const res = await requestJson(server, {
      path: '/api/projects/proj-remove-me/remove',
      headers: authHeaders,
      body: { expected_binding_revision: 1 }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.binding_id, 'proj-remove-me');
    // 人类后果语言，不暴露内部状态机技术术语 (如 NEW / UNKNOWN / RESULT_REF / CURSOR 等)
    assert.match(res.data.message, /移出/);

    // 活跃集合已收敛
    assert.equal(registry.hasProject('proj-remove-me'), false);
    assert.equal(registry.listProjects().length, 1);
    assert.equal(registry.hasProject('proj-stay-here'), true);

    // 留存事实可查
    assert.equal(registry.hasRemovedProject('proj-remove-me'), true);
  } finally {
    server.close();
  }
});
