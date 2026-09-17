/**
 * 本地状态表面 HTTP 服务模块 (Surface Server)
 * 依赖轻量级 node:http 原生模块，直接由 ProjectRegistry / Status Core 驱动
 *
 * 领域不变式与规范准则 (#17):
 * 1. 唯一真实数据源：直接读取 ProjectRegistry 派生规范只读状态，不建立独立存储；
 * 2. 唯一允许的规范变更：精确端点 Mark handled，调用 markProjectEndpointHandled；
 * 3. 严格隔离：浏览器端点 handled 绝不影响 IDE 端点；IDE-A handled 绝不影响 Browser 或 IDE-B；
 * 4. 游标失配严格拦截：若 expected_cursor 不匹配当前完成游标或端点未受信，立即返回失败且绝不篡改事实。
 */

import http from 'node:http';
import { projectRegistrySurface } from './surface-projection.js';
import { renderStatusSurfaceHtml } from './surface-template.js';

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendHtml(res, statusCode, html) {
  const payload = Buffer.from(html, 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 创建状态表面 HTTP 处理器
 * @param {object} params
 * @param {import('../registry/project-registry.js').ProjectRegistry} params.registry
 */
export function createStatusSurfaceRequestHandler({ registry }) {
  if (!registry || typeof registry.listProjects !== 'function') {
    throw new Error('Valid ProjectRegistry instance is required for Status Surface Server');
  }

  return async function requestHandler(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const method = req.method.toUpperCase();

    // 1. GET / 或 /index.html: 渲染状态表面 HTML
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      try {
        const projects = projectRegistrySurface(registry);
        const html = renderStatusSurfaceHtml({ projects });
        return sendHtml(res, 200, html);
      } catch (err) {
        return sendJson(res, 500, { error: `Internal Server Error: ${err.message}` });
      }
    }

    // 2. GET /api/projects: 返回所有项目规范表面投影 JSON
    if (method === 'GET' && pathname === '/api/projects') {
      try {
        const projects = projectRegistrySurface(registry);
        return sendJson(res, 200, { projects });
      } catch (err) {
        return sendJson(res, 500, { error: `Internal Server Error: ${err.message}` });
      }
    }

    // 3. POST /api/projects/:bindingId/endpoints/:endpointId/handled: 精确端点 Mark handled
    const handledMatch = pathname.match(/^\/api\/projects\/([^/]+)\/endpoints\/([^/]+)\/handled$/);
    if (method === 'POST' && handledMatch) {
      const bindingId = decodeURIComponent(handledMatch[1]);
      const endpointId = decodeURIComponent(handledMatch[2]);

      let body = {};
      try {
        body = await parseBody(req);
      } catch (err) {
        return sendJson(res, 400, { success: false, reason: err.message });
      }

      if (!registry.hasProject(bindingId)) {
        return sendJson(res, 404, { success: false, reason: `Project "${bindingId}" not found` });
      }

      try {
        const expectedCursor = body.expected_cursor;
        const result = registry.markProjectEndpointHandled(bindingId, endpointId, {
          expected_cursor: expectedCursor
        });

        if (result.success) {
          const snapshot = registry.getProject(bindingId).getSnapshot();
          return sendJson(res, 200, {
            success: true,
            handled_cursor: result.handled_cursor,
            project: snapshot
          });
        } else {
          return sendJson(res, 400, {
            success: false,
            reason: result.reason || 'Failed to mark handled'
          });
        }
      } catch (err) {
        return sendJson(res, 400, { success: false, reason: err.message });
      }
    }

    // 4. 其他路由 Fail-Closed 404
    sendJson(res, 404, { error: 'Not Found' });
  };
}

/**
 * 启动状态表面本地服务
 * @param {object} params
 * @param {import('../registry/project-registry.js').ProjectRegistry} params.registry
 * @param {number} [params.port=0]
 * @param {string} [params.host='127.0.0.1']
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startStatusSurfaceServer({ registry, port = 0, host = '127.0.0.1' }) {
  const handler = createStatusSurfaceRequestHandler({ registry });
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      const url = `http://${host}:${actualPort}`;

      resolve({
        server,
        port: actualPort,
        url,
        close: () => new Promise(res => server.close(res))
      });
    });
  });
}
