/**
 * 状态表面安全与本地信任边界模块 (Surface Security)
 * 遵循 Issue #28 规范与最小本地信任边界原则：
 * 1. 严格限制仅监听环回地址 (Loopback Only)；
 * 2. 校验请求 Host 与 Origin，阻断跨源攻击与 DNS 重新绑定；
 * 3. 校验应用层会话能力令牌 (Session Capability Token)；
 * 4. 严格强制突变端点必须提供 application/json Content-Type；
 * 5. 校验独立的 Antigravity Hook 凭据 (Hook Secret)。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sendJson } from './http-helpers.js';

/**
 * 判断指定主机名/IP 是否为合法环回地址
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (!host || typeof host !== 'string') {
    return false;
  }
  const clean = host.trim().toLowerCase();
  if (clean === 'localhost') {
    return true;
  }
  if (clean === '::1' || clean === '[::1]' || clean === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // IPv4 环回地址段: 127.0.0.0/8
  const ipv4LoopbackRegex = /^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
  if (ipv4LoopbackRegex.test(clean)) {
    return true;
  }
  return false;
}

/**
 * 校验监听地址，若非环回地址则严格 Fail-Closed
 * @param {string} host
 */
export function assertLoopbackBind(host) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `NON_LOOPBACK_BIND_REFUSED: Status Surface only permits loopback binding (e.g. 127.0.0.1, localhost, ::1). Received: "${host}"`
    );
  }
}

/**
 * 校验请求的 Host 请求头是否为当前 Rally 实例的 loopback 监听地址 (listener-aware)
 * @param {import('node:http').IncomingMessage} req
 * @param {object} [context]
 * @param {string} [context.expectedHost] 期望的 host (如 127.0.0.1, localhost)
 * @param {number} [context.expectedPort] 期望的 port
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateHostHeader(req, context = {}) {
  const rawHost = req.headers.host;
  if (!rawHost || typeof rawHost !== 'string') {
    return { valid: false, reason: 'MISSING_HOST_HEADER' };
  }

  const cleanHost = rawHost.trim();
  let hostname = cleanHost;
  let port = null;

  if (cleanHost.startsWith('[')) {
    const endBracket = cleanHost.indexOf(']');
    if (endBracket !== -1) {
      hostname = cleanHost.slice(0, endBracket + 1);
      const after = cleanHost.slice(endBracket + 1);
      if (after.startsWith(':')) {
        port = parseInt(after.slice(1), 10);
      }
    }
  } else {
    const colonIdx = cleanHost.indexOf(':');
    if (colonIdx !== -1) {
      hostname = cleanHost.slice(0, colonIdx);
      port = parseInt(cleanHost.slice(colonIdx + 1), 10);
    }
  }

  if (!isLoopbackHost(hostname)) {
    return { valid: false, reason: 'INVALID_HOST_HEADER' };
  }

  const { expectedHost, expectedPort } = context;
  if (expectedPort !== undefined && expectedPort !== null) {
    if (port === null || isNaN(port) || port !== expectedPort) {
      return { valid: false, reason: 'INVALID_HOST_HEADER_PORT_MISMATCH' };
    }
  }

  if (expectedHost && typeof expectedHost === 'string') {
    const normalizeHost = (h) => {
      let s = h.trim().toLowerCase();
      if (s.startsWith('[') && s.endsWith(']')) {
        s = s.slice(1, -1);
      }
      if (s === '0:0:0:0:0:0:0:1') {
        s = '::1';
      }
      return s;
    };
    const cleanExp = normalizeHost(expectedHost);
    const cleanReq = normalizeHost(hostname);

    if (cleanExp !== cleanReq) {
      return { valid: false, reason: 'INVALID_HOST_HEADER_HOST_MISMATCH' };
    }
  }

  return { valid: true };
}

/**
 * 校验请求的 Origin / Referer 请求头是否严格匹配当前 Rally 实例的服务 Origin (listener-aware)
 * 必须同时匹配实际 served scheme (http:) + host + port
 * 遵循 Issue #28 Blocker 1: 严格匹配实际 listener host，禁止将 localhost 与 127.x 视为 same-origin
 * @param {import('node:http').IncomingMessage} req
 * @param {object} [context]
 * @param {string} [context.expectedHost]
 * @param {number} [context.expectedPort]
 * @param {string} [context.expectedScheme='http:']
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateOriginHeader(req, context = {}) {
  const { expectedHost, expectedPort, expectedScheme = 'http:' } = context;

  const checkUrl = (urlStr, isOrigin) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (_) {
      return { valid: false, reason: isOrigin ? 'MALFORMED_ORIGIN' : 'MALFORMED_REFERER' };
    }

    // 1. Strict same-origin: 校验实际服务协议 (当前 Rally 仅通过 node:http 提供服务)
    if (url.protocol !== expectedScheme) {
      return { valid: false, reason: isOrigin ? 'UNAUTHORIZED_ORIGIN_SCHEME_MISMATCH' : 'UNAUTHORIZED_REFERER_SCHEME_MISMATCH' };
    }

    // 2. 必须是环回地址
    if (!isLoopbackHost(url.hostname)) {
      return { valid: false, reason: isOrigin ? 'UNAUTHORIZED_ORIGIN' : 'UNAUTHORIZED_REFERER' };
    }

    // 3. 严格校验端口
    if (expectedPort !== undefined && expectedPort !== null) {
      const portNum = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
      if (portNum !== expectedPort) {
        return { valid: false, reason: isOrigin ? 'UNAUTHORIZED_ORIGIN_PORT_MISMATCH' : 'UNAUTHORIZED_REFERER_PORT_MISMATCH' };
      }
    }

    // 4. 严格校验主机 (语法规范化：case, IPv6 brackets, 纯等价 IPv6 textual form；严禁将 localhost 与 127.x 当成 same-origin)
    if (expectedHost && typeof expectedHost === 'string') {
      const normalizeHost = (h) => {
        let s = h.trim().toLowerCase();
        if (s.startsWith('[') && s.endsWith(']')) {
          s = s.slice(1, -1);
        }
        if (s === '0:0:0:0:0:0:0:1') {
          s = '::1';
        }
        return s;
      };
      const cleanExp = normalizeHost(expectedHost);
      const cleanUrlHost = normalizeHost(url.hostname);

      if (cleanExp !== cleanUrlHost) {
        return { valid: false, reason: isOrigin ? 'UNAUTHORIZED_ORIGIN_HOST_MISMATCH' : 'UNAUTHORIZED_REFERER_HOST_MISMATCH' };
      }
    }

    return { valid: true };
  };

  const origin = req.headers.origin;
  if (origin && typeof origin === 'string') {
    return checkUrl(origin, true);
  }

  const referer = req.headers.referer;
  if (referer && typeof referer === 'string') {
    return checkUrl(referer, false);
  }

  return { valid: true };
}

/**
 * 校验突变请求的 Content-Type 是否为 application/json
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateJsonContentType(req) {
  const ct = req.headers['content-type'];
  if (!ct || typeof ct !== 'string') {
    return { valid: false, reason: 'UNSUPPORTED_MEDIA_TYPE_JSON_REQUIRED' };
  }
  const mainType = ct.split(';')[0].trim().toLowerCase();
  if (mainType !== 'application/json') {
    return { valid: false, reason: 'UNSUPPORTED_MEDIA_TYPE_JSON_REQUIRED' };
  }
  return { valid: true };
}

/**
 * 生成安全的随机会话能力令牌
 * @returns {string}
 */
export function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * 安全时间比对两个字符串，防止时序侧信道攻击
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 校验 Browser/Operator 的会话能力令牌
 * 遵循 Issue #28 Blocker 1: 必须要求显式 X-Rally-Session-Token 或 Authorization: Bearer，
 * 绝不允许仅凭 cookie 进行隐式突变授权
 * @param {import('node:http').IncomingMessage} req
 * @param {string} expectedToken
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateOperatorSession(req, expectedToken) {
  if (!expectedToken) {
    return { valid: false, reason: 'SERVER_SESSION_TOKEN_UNSET' };
  }

  // 1. 尝试从 Header 获取: X-Rally-Session-Token (主要能力凭证)
  const headerToken = req.headers['x-rally-session-token'];
  if (typeof headerToken === 'string' && safeEqual(headerToken.trim(), expectedToken)) {
    return { valid: true };
  }

  // 2. 尝试从 Authorization Bearer 获取
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (safeEqual(bearerToken, expectedToken)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'MISSING_OR_INVALID_SESSION_TOKEN' };
}

const DEFAULT_RALLY_USER_DIR = path.join(os.homedir(), '.browser-ide-rally');
const DEFAULT_HOOK_SECRET_PATH = path.join(DEFAULT_RALLY_USER_DIR, 'hook-secret');

/**
 * 解析或初始化本地 Hook 凭据 (Hook Secret)
 * 遵循 Issue #28 Blocker 3: 若无显式 secret、无环境变量且持久化存储无法可靠读写，严格 Fail-Closed
 * @param {object} [options]
 * @param {string} [options.hookSecret]
 * @param {string} [options.secretFilePath]
 * @returns {string}
 */
export function resolveOrCreateHookSecret({ hookSecret = null, secretFilePath = null } = {}) {
  if (hookSecret && typeof hookSecret === 'string' && hookSecret.trim()) {
    return hookSecret.trim();
  }

  if (process.env.RALLY_HOOK_SECRET && process.env.RALLY_HOOK_SECRET.trim()) {
    return process.env.RALLY_HOOK_SECRET.trim();
  }

  const targetPath = secretFilePath || DEFAULT_HOOK_SECRET_PATH;
  try {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf8').trim();
      if (content.length > 0) {
        return content;
      }
    }

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const newSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(targetPath, newSecret + '\n', { encoding: 'utf8', mode: 0o600 });
    return newSecret;
  } catch (err) {
    const durableError = new Error(
      `DURABLE_HOOK_SECRET_UNAVAILABLE: Failed to read or create durable Hook credential at "${targetPath}". ` +
      `Failing closed to prevent unreachable in-memory secret divergence: ${err.message}`
    );
    durableError.code = 'DURABLE_HOOK_SECRET_UNAVAILABLE';
    throw durableError;
  }
}

/**
 * 校验 Antigravity Hook 凭据
 * @param {import('node:http').IncomingMessage} req
 * @param {string} expectedHookSecret
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateHookCredential(req, expectedHookSecret) {
  if (!expectedHookSecret) {
    return { valid: false, reason: 'SERVER_HOOK_SECRET_UNSET' };
  }

  // 1. 尝试从 Header 获取: X-Rally-Hook-Secret
  const headerSecret = req.headers['x-rally-hook-secret'];
  if (typeof headerSecret === 'string' && safeEqual(headerSecret.trim(), expectedHookSecret)) {
    return { valid: true };
  }

  // 2. 尝试从 Authorization Bearer 获取
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearerSecret = authHeader.slice(7).trim();
    if (safeEqual(bearerSecret, expectedHookSecret)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'MISSING_OR_INVALID_HOOK_CREDENTIAL' };
}

/**
 * 校验所有 POST 突变请求的安全门禁 (Host + Origin + Content-Type + 隔离凭据)
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} params
 * @param {string} params.sessionToken
 * @param {string} params.hookSecret
 * @param {string} params.pathname
 * @param {object} [params.context] listener-aware 校验上下文 ({ expectedHost, expectedPort })
 * @returns {boolean} true 表示放行，false 表示已被门禁拦截并响应
 */
export function verifyMutationSecurityGate(req, res, { sessionToken, hookSecret, pathname, context = {} }) {
  // 1. 校验 Host 请求头（防 DNS 重新绑定，listener-aware）
  const hostCheck = validateHostHeader(req, context);
  if (!hostCheck.valid) {
    sendJson(res, 403, { success: false, reason: hostCheck.reason });
    return false;
  }

  // 2. 校验 Origin / Referer 请求头（防跨源 CSRF / 外网调用，listener-aware）
  const originCheck = validateOriginHeader(req, context);
  if (!originCheck.valid) {
    sendJson(res, 403, { success: false, reason: originCheck.reason });
    return false;
  }

  // 3. 校验 Content-Type 必须为 application/json
  const ctCheck = validateJsonContentType(req);
  if (!ctCheck.valid) {
    sendJson(res, 415, { success: false, reason: ctCheck.reason });
    return false;
  }

  // 4. 凭据隔离：Hook 端点与普通 Operator 突变端点严格分离
  if (pathname === '/api/hooks/antigravity') {
    const hookCheck = validateHookCredential(req, hookSecret);
    if (!hookCheck.valid) {
      sendJson(res, 401, { success: false, reason: hookCheck.reason });
      return false;
    }
  } else {
    const sessionCheck = validateOperatorSession(req, sessionToken);
    if (!sessionCheck.valid) {
      sendJson(res, 403, { success: false, reason: sessionCheck.reason });
      return false;
    }
  }

  return true;
}

/**
 * 判断指定请求路径是否为状态表面规范突变端点
 * @param {string} pathname
 * @returns {boolean}
 */
export function isMutationRoute(pathname) {
  if (typeof pathname !== 'string') return false;
  return /^\/api\/projects\/[^/]+\/endpoints\/[^/]+\/handled$/.test(pathname) ||
         /^\/api\/projects\/[^/]+\/human-intervention\/(?:assert|clear)$/.test(pathname) ||
         /^\/api\/projects\/[^/]+\/controls\/(?:rebind|open-focus|send|continue)$/.test(pathname) ||
         pathname === '/api/onboarding/verify' ||
         pathname === '/api/onboarding/create' ||
         pathname === '/api/hooks/antigravity';
}
