#!/usr/bin/env node

/**
 * Antigravity Stop Hook -> Rally Bridge Script
 * 
 * 职责：
 * 1. 从 stdin 读取 Antigravity 官方 Stop Hook 载荷；
 * 2. 忠实保留原始载荷并以 POST 转发至 Rally 状态表面的 /api/hooks/antigravity；
 * 3. 安全失败原则：如果 Rally 未启动（ECONNREFUSED）、超时或网络错误，静默退出，绝不阻断 Antigravity；
 * 4. 向 stdout 输出 "{}" 并以状态码 0 退出，符合 Antigravity Hook 契约。
 */

import http from 'node:http';

async function main() {
  const outputSafeResult = () => {
    try {
      process.stdout.write('{}\n');
    } catch (_) {}
  };

  let rawStdin = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      rawStdin += chunk;
    }
  } catch (_) {
    outputSafeResult();
    process.exit(0);
  }

  if (!rawStdin.trim()) {
    outputSafeResult();
    process.exit(0);
  }

  let hookPayload;
  try {
    hookPayload = JSON.parse(rawStdin);
  } catch (_) {
    outputSafeResult();
    process.exit(0);
  }

  const targetUrlStr = process.env.RALLY_SURFACE_URL || 'http://127.0.0.1:3123/api/hooks/antigravity';
  try {
    const targetUrl = new URL(targetUrlStr);
    const postData = Buffer.from(JSON.stringify(hookPayload), 'utf8');

    await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + (targetUrl.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': postData.length
          },
          timeout: 1000
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(true));
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(postData);
      req.end();
    });
  } catch (_) {
    // 静默安全失败
  }

  outputSafeResult();
  process.exit(0);
}

main();
