import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { WorkspaceHookManager } from '../../src/runtime/workspace-hook-manager.js';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

function createTempDir(prefix = 'rally-hook-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('WorkspaceHookManager TDD Suite', () => {
  let tempBaseDir;
  let binDir;
  let manager;

  beforeEach(() => {
    tempBaseDir = createTempDir();
    binDir = path.join(tempBaseDir, 'bin');
    manager = new WorkspaceHookManager({
      binDir,
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempBaseDir)) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  it('A. Hook install first binding: installs exactly one Rally hook and creates allowlist', () => {
    const ws = path.join(tempBaseDir, 'ws-a');
    fs.mkdirSync(ws, { recursive: true });

    const res = manager.ensureWorkspaceHook(ws, 'conv-1');
    assert.equal(res.success, true);

    const hooksPath = path.join(ws, '.agents', 'hooks.json');
    assert.ok(fs.existsSync(hooksPath), 'hooks.json should exist');
    const hooksData = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(hooksData['rally-ide-stop-hook'], 'rally-ide-stop-hook must exist');
    assert.equal(hooksData['rally-ide-stop-hook'].Stop[0].type, 'command');
    assert.ok(hooksData['rally-ide-stop-hook'].Stop[0].command.includes(manager.getStableBridgePath()));

    const allowlistPath = path.join(ws, '.agents', 'rally-conversations.json');
    assert.ok(fs.existsSync(allowlistPath), 'rally-conversations.json must exist');
    const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    assert.deepEqual(allowlist.conversations, ['conv-1']);
  });

  it('B. Same workspace second binding: updates allowlist without duplicating hook entry', () => {
    const ws = path.join(tempBaseDir, 'ws-b');
    fs.mkdirSync(ws, { recursive: true });

    manager.ensureWorkspaceHook(ws, 'conv-1');
    manager.ensureWorkspaceHook(ws, 'conv-2');

    const hooksData = JSON.parse(fs.readFileSync(path.join(ws, '.agents', 'hooks.json'), 'utf8'));
    assert.equal(Object.keys(hooksData).length, 1);
    assert.ok(hooksData['rally-ide-stop-hook']);

    const allowlist = JSON.parse(fs.readFileSync(path.join(ws, '.agents', 'rally-conversations.json'), 'utf8'));
    assert.deepEqual(allowlist.conversations.sort(), ['conv-1', 'conv-2']);
  });

  it('C. Last binding cleanup: removes allowlist and Rally hook entry when last binding removed', () => {
    const ws = path.join(tempBaseDir, 'ws-c');
    fs.mkdirSync(ws, { recursive: true });

    manager.ensureWorkspaceHook(ws, 'conv-1');
    const res = manager.removeWorkspaceHook(ws, 'conv-1');
    assert.equal(res.success, true);
    assert.equal(res.remaining, 0);
    assert.equal(res.removedHook, true);

    assert.equal(fs.existsSync(path.join(ws, '.agents', 'rally-conversations.json')), false);
    assert.equal(fs.existsSync(path.join(ws, '.agents', 'hooks.json')), false);
    assert.equal(fs.existsSync(path.join(ws, '.agents')), false);
  });

  it('D. Existing unrelated hooks: preserves other tools in hooks.json during install and cleanup', () => {
    const ws = path.join(tempBaseDir, 'ws-d');
    fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
    const hooksPath = path.join(ws, '.agents', 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      'other-lint-tool': {
        Stop: [{ type: 'command', command: 'echo linting' }]
      }
    }, null, 2), 'utf8');

    manager.ensureWorkspaceHook(ws, 'conv-1');
    let hooksData = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(hooksData['other-lint-tool'], 'other tool must be preserved on install');
    assert.ok(hooksData['rally-ide-stop-hook'], 'rally hook added');

    manager.removeWorkspaceHook(ws, 'conv-1');
    hooksData = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(hooksData['other-lint-tool'], 'other tool must be preserved on removal');
    assert.equal(hooksData['rally-ide-stop-hook'], undefined, 'rally hook removed');
  });

  it('E. Idempotence: repeated install and repeated cleanup are completely safe and idempotent', () => {
    const ws = path.join(tempBaseDir, 'ws-e');
    fs.mkdirSync(ws, { recursive: true });

    manager.ensureWorkspaceHook(ws, 'conv-1');
    const content1 = fs.readFileSync(path.join(ws, '.agents', 'hooks.json'), 'utf8');
    manager.ensureWorkspaceHook(ws, 'conv-1');
    const content2 = fs.readFileSync(path.join(ws, '.agents', 'hooks.json'), 'utf8');
    assert.equal(content1, content2);

    manager.removeWorkspaceHook(ws, 'conv-1');
    const cleanRes = manager.removeWorkspaceHook(ws, 'conv-1');
    assert.equal(cleanRes.success, true);
  });

  it('F. Tracked hook protection: fails closed if .agents/hooks.json is tracked by Git', () => {
    const ws = path.join(tempBaseDir, 'ws-f');
    fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
    execFileSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'tester@test.com'], { cwd: ws, stdio: 'ignore' });

    const hooksPath = path.join(ws, '.agents', 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({ 'user-tracked-hook': {} }), 'utf8');
    execFileSync('git', ['add', '.agents/hooks.json'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'track hooks.json'], { cwd: ws, stdio: 'ignore' });

    const res = manager.ensureWorkspaceHook(ws, 'conv-tracked');
    assert.equal(res.success, false);
    assert.equal(res.reason, 'WORKSPACE_HOOK_REQUIRES_USER_DECISION');

    // 确认文件完全未被篡改
    const content = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(content['rally-ide-stop-hook'], undefined);
  });

  it('G. Git cleanliness: untracked git workspace excludes rally files via .git/info/exclude without dirtying git status', () => {
    const ws = path.join(tempBaseDir, 'ws-g');
    fs.mkdirSync(ws, { recursive: true });
    execFileSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'tester@test.com'], { cwd: ws, stdio: 'ignore' });

    // 创建并提交一个测试文件
    fs.writeFileSync(path.join(ws, 'README.md'), '# Test\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: ws, stdio: 'ignore' });

    // 执行 Rally hook 安装
    const res = manager.ensureWorkspaceHook(ws, 'conv-git-clean');
    assert.equal(res.success, true);

    // 验证 .gitignore 没有被创建或修改
    assert.equal(fs.existsSync(path.join(ws, '.gitignore')), false);

    // 验证 .git/info/exclude 包含了 Rally 专有条目
    const excludeContent = fs.readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(excludeContent.includes('.agents/hooks.json'));
    assert.ok(excludeContent.includes('.agents/rally-conversations.json'));

    // 验证 git status --porcelain 干净如初
    const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' }).trim();
    assert.equal(statusOut, '', 'git status must be completely clean with zero untracked files');
  });

  it('H. Unrelated workspace isolation: unrelated workspace is never touched', () => {
    const wsUnrelated = path.join(tempBaseDir, 'ws-unrelated');
    fs.mkdirSync(wsUnrelated, { recursive: true });

    // 重建注册表，仅注册 ws-a
    const wsA = path.join(tempBaseDir, 'ws-a');
    fs.mkdirSync(wsA, { recursive: true });

    const registry = createProjectRegistry();
    registry.registerProject({
      binding: createBinding({
        binding_id: 'proj-a',
        display_name: 'Project A',
        browser: { provider: 'chatgpt', conversation_id: 'chatgpt-a' },
        ide_endpoints: [{
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-a-1',
          workspace_identity: wsA,
          repository_identity: 'repo-a'
        }]
      })
    });

    manager.reconcileWorkspaceHooks(registry);

    assert.equal(fs.existsSync(path.join(wsUnrelated, '.agents')), false);
  });

  it('I. Bridge missing: nonexistent bridge script safe no-op exit 0', () => {
    const bridgeScript = path.resolve('scripts/antigravity-stop-hook.mjs');
    const out = spawnSync('node', [bridgeScript], {
      input: JSON.stringify({ conversationId: 'conv-none' }),
      encoding: 'utf8'
    });
    assert.equal(out.status, 0);
    assert.equal(out.stdout.trim(), '{}');
  });

  it('J. Unbound conversation short-circuit: bridge exits 0 without HTTP request when conversation not in allowlist', async () => {
    const ws = path.join(tempBaseDir, 'ws-j');
    fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agents', 'rally-conversations.json'), JSON.stringify({
      conversations: ['bound-conv-123']
    }), 'utf8');

    let serverHit = false;
    const server = http.createServer((req, res) => {
      serverHit = true;
      res.writeHead(200);
      res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    fs.writeFileSync(path.join(ws, '.agents', 'hook-url'), `http://127.0.0.1:${port}/api/hooks/antigravity`, 'utf8');

    const bridgeScript = path.resolve('scripts/antigravity-stop-hook.mjs');
    const out = spawnSync('node', [bridgeScript], {
      cwd: ws,
      input: JSON.stringify({
        conversationId: 'unbound-conv-999',
        workspacePath: ws
      }),
      encoding: 'utf8'
    });

    server.close();
    assert.equal(out.status, 0);
    assert.equal(out.stdout.trim(), '{}');
    assert.equal(serverHit, false, 'Unbound conversation must never trigger HTTP request');
  });

  it('K. Bound conversation forwards: bridge sends raw payload to Rally ingress exactly once', async () => {
    const ws = path.join(tempBaseDir, 'ws-k');
    fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agents', 'rally-conversations.json'), JSON.stringify({
      conversations: ['bound-conv-ok']
    }), 'utf8');

    let receivedPayload = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    fs.writeFileSync(path.join(ws, '.agents', 'hook-url'), `http://127.0.0.1:${port}/api/hooks/antigravity`, 'utf8');

    const bridgeScript = path.resolve('scripts/antigravity-stop-hook.mjs');
    const rawInput = {
      conversationId: 'bound-conv-ok',
      workspacePath: ws,
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL'
    };

    const cp = await import('node:child_process');
    const out = await new Promise((resolve, reject) => {
      const child = cp.execFile('node', [bridgeScript], { cwd: ws, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
      child.stdin.write(JSON.stringify(rawInput));
      child.stdin.end();
    });

    server.close();
    assert.equal(out.stdout.trim(), '{}');
    assert.ok(receivedPayload !== null, 'Server must receive payload');
    assert.equal(receivedPayload.conversationId, 'bound-conv-ok');
    assert.equal(receivedPayload.fullyIdle, true);
  });

  it('L. Same workspace multi-conversation: handles bound convs, ignores unbound', () => {
    const ws = path.join(tempBaseDir, 'ws-l');
    fs.mkdirSync(ws, { recursive: true });
    manager.ensureWorkspaceHook(ws, 'conv-A');
    manager.ensureWorkspaceHook(ws, 'conv-B');

    const allowlist = JSON.parse(fs.readFileSync(path.join(ws, '.agents', 'rally-conversations.json'), 'utf8'));
    assert.ok(allowlist.conversations.includes('conv-A'));
    assert.ok(allowlist.conversations.includes('conv-B'));
    assert.equal(allowlist.conversations.includes('conv-C'), false);
  });

  it('M. Registry reconciliation: reconstructs missing allowlist from canonical registry truth', () => {
    const ws = path.join(tempBaseDir, 'ws-m');
    fs.mkdirSync(ws, { recursive: true });

    const registry = createProjectRegistry();
    registry.registerProject({
      binding: createBinding({
        binding_id: 'proj-m',
        display_name: 'Project M',
        browser: { provider: 'chatgpt', conversation_id: 'chatgpt-m' },
        ide_endpoints: [{
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-m-100',
          workspace_identity: ws,
          repository_identity: 'repo-m'
        }]
      })
    });

    // 初始没有 .agents 目录，执行对齐
    const res = manager.reconcileWorkspaceHooks(registry);
    assert.equal(res.reconciledWorkspaces, 1);

    const allowlist = JSON.parse(fs.readFileSync(path.join(ws, '.agents', 'rally-conversations.json'), 'utf8'));
    assert.deepEqual(allowlist.conversations, ['conv-m-100']);
  });

  it('N. Last subscription cleanup: removes hook when last conversation is unsubscribed', () => {
    const ws = path.join(tempBaseDir, 'ws-n');
    fs.mkdirSync(ws, { recursive: true });
    manager.ensureWorkspaceHook(ws, 'conv-n1');
    manager.ensureWorkspaceHook(ws, 'conv-n2');

    // 移除第一个会话：Hook 依然保留
    manager.removeWorkspaceHook(ws, 'conv-n1');
    assert.ok(fs.existsSync(path.join(ws, '.agents', 'hooks.json')));

    // 移除最后一个会话：Hook 与白名单彻底清理
    manager.removeWorkspaceHook(ws, 'conv-n2');
    assert.equal(fs.existsSync(path.join(ws, '.agents', 'rally-conversations.json')), false);
    assert.equal(fs.existsSync(path.join(ws, '.agents', 'hooks.json')), false);
  });
});
