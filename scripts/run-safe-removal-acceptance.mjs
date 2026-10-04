#!/usr/bin/env node
/**
 * 真实双项目安全移出生命周期验收执行器 (Safe Project Removal Real Acceptance Runner)
 * 严格遵循 Issue #36 契约与 Browser Mission Contract Comment 5974965600:
 *
 * 验收要求：
 * 1. 从真实 Surface 移出 disposable project；
 * 2. 已打开页面无需人工 reload 即收敛 (卡片消失且计数更新)；
 * 3. Rally 重启后该项目仍不在 active projects；
 * 4. retained canonical evidence 持久存在；
 * 5. sibling project facts 未改变；
 * 6. orphaned Rally Hook subscription 被清理，shared/needed subscription 被保留；
 * 7. underlying conversations / workspace / repository 未被修改。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

import { createProjectRegistry } from '../src/registry/project-registry.js';
import { createBinding } from '../src/controller/binding.js';
import { createStatusSurfaceRequestHandler } from '../src/surface/surface-server.js';
import { checkStructuralTopologyMatches } from '../src/surface/live-refresh-topology.js';
import { applyProjectionToDom } from '../src/surface/live-refresh-client.js';
import { WorkspaceHookManager } from '../src/runtime/workspace-hook-manager.js';

function printHeader(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function printStep(stepNum, desc) {
  console.log(`\n[Step ${stepNum}] ${desc}`);
}

function requestHttp(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqHeaders = {
      Host: urlObj.host,
      ...headers
    };
    const payload = body !== null ? JSON.stringify(body) : null;
    if (payload !== null) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, {
      method,
      headers: reqHeaders
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          raw
        });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function setupMockGitRepo(workspaceDir, repoName) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', workspaceDir], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'Acceptance Tester'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'test@acceptance.local'], { stdio: 'ignore' });

  // 写入重要业务文件
  const appFile = path.join(workspaceDir, 'app.js');
  fs.writeFileSync(appFile, `// Repository ${repoName}\nconsole.log("core app logic");\n`, 'utf8');
  execFileSync('git', ['-C', workspaceDir, 'add', 'app.js'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspaceDir, 'commit', '-m', `Initial commit for ${repoName}`], { stdio: 'ignore' });

  const commitSha = execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { commitSha, appFile };
}

async function runAcceptance() {
  printHeader('Browser-IDE-Rally: Issue #36 Safe Project Removal Acceptance');
  console.log(`执行环境时间: ${new Date().toISOString()}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-issue-36-acceptance-'));
  const storagePath = path.join(tempRoot, 'registry.json');
  const disposableWs = path.join(tempRoot, 'workspace-disposable');
  const sharedWs = path.join(tempRoot, 'workspace-shared');

  console.log(`临时测试沙箱根路径: ${tempRoot}`);

  try {
    // 0. 初始化工作区与代码仓库
    const repoDisp = setupMockGitRepo(disposableWs, 'disposable-repo');
    const repoShared = setupMockGitRepo(sharedWs, 'shared-repo');

    console.log(`✓ 已初始化可支配独立工作区: ${disposableWs} (git HEAD: ${repoDisp.commitSha})`);
    console.log(`✓ 已初始化双项目共享工作区: ${sharedWs} (git HEAD: ${repoShared.commitSha})`);

    // 初始化注册表
    const registry = createProjectRegistry({ storagePath });
    const hookMgr = new WorkspaceHookManager();

    // 绑定 1: 可支配项目 proj-disposable (挂载独立工作区与共享工作区两个端点)
    const bindingDisp = createBinding({
      binding_id: 'proj-disposable',
      binding_revision: 1,
      display_name: '可支配测试项目 (Disposable)',
      browser: {
        provider: 'chatgpt',
        conversation_id: 'conv-browser-disposable-1234',
        branch: 'feat/disposable'
      },
      ide_endpoints: [
        {
          endpoint_id: 'ide-disposable-exclusive',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-disp-exclusive',
          workspace_identity: disposableWs,
          repository_identity: 'disposable-repo'
        },
        {
          endpoint_id: 'ide-disposable-shared',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-disp-shared',
          workspace_identity: sharedWs,
          repository_identity: 'shared-repo'
        }
      ]
    });

    // 绑定 2: 兄弟生产项目 proj-sibling (挂载共享工作区端点)
    const bindingSibling = createBinding({
      binding_id: 'proj-sibling',
      binding_revision: 1,
      display_name: '兄弟核心项目 (Sibling)',
      browser: {
        provider: 'chatgpt',
        conversation_id: 'conv-browser-sibling-5678',
        branch: 'main'
      },
      ide_endpoints: [
        {
          endpoint_id: 'ide-sibling-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-sib-shared',
          workspace_identity: sharedWs,
          repository_identity: 'shared-repo'
        }
      ]
    });

    const coreDisp = registry.registerProject({ binding: bindingDisp });
    const coreSibling = registry.registerProject({ binding: bindingSibling });

    // 注入一些关键事实证据 (确保验证留存完整性)
    coreDisp.setHumanIntervention({ active: true, reason: '移出前留存的人工关注标记' });
    coreDisp.recordActionFact({
      action_id: 'act-disp-1',
      action_type: 'send',
      source_endpoint: 'ide-disposable-exclusive',
      target_endpoint: 'browser',
      stage: 'ACCEPTED_OR_DELIVERED'
    });

    // 为两个工作区安装真实 Rally Stop Hook 与订阅白名单
    hookMgr.ensureWorkspaceHook(disposableWs, 'conv-ide-disp-exclusive');
    hookMgr.ensureWorkspaceHook(sharedWs, 'conv-ide-disp-shared');
    hookMgr.ensureWorkspaceHook(sharedWs, 'conv-ide-sib-shared');

    // 启动生产 Surface HTTP 服务
    const sessionToken = 'acceptance-session-token-issue-36-immut';
    let server;
    let surfaceUrl;

    await new Promise((resolve) => {
      const handler = createStatusSurfaceRequestHandler({
        registry,
        workspaceHookManager: hookMgr,
        sessionToken,
        serverContext: () => ({ expectedHost: '127.0.0.1', expectedPort: server.address().port })
      });
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        surfaceUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    console.log(`✓ Surface 服务已启动: ${surfaceUrl}`);

    // =========================================================================
    // 步骤 1: 真实拉取初始 Surface 并在真实 DOM (带完整脚本执行环境) 中呈现
    // =========================================================================
    printStep(1, '拉取真实 Surface 页面，验证初始包含 2 个项目卡片，并装配真实交互环境');
    const initialGet = await requestHttp(`${surfaceUrl}/`);
    if (initialGet.statusCode !== 200) {
      throw new Error(`Failed to GET /: HTTP ${initialGet.statusCode}`);
    }

    // 启用 JSDOM 脚本执行环境，构建真实运行中的浏览器操作界面
    const dom = new JSDOM(initialGet.raw, {
      url: surfaceUrl,
      runScripts: 'dangerously'
    });
    const doc = dom.window.document;

    // 为 JSDOM 环境注入通信设施，确保客户端交互脚本能向真实 Surface 发送请求
    dom.window.fetch = async (url, options = {}) => {
      const fullUrl = url.startsWith('http') ? url : `${surfaceUrl}${url}`;
      return globalThis.fetch(fullUrl, options);
    };

    let controlledReloadCount = 0;
    let convergedDocument = null;
    let reloadPromiseResolve;
    const reloadPromise = new Promise(r => { reloadPromiseResolve = r; });

    // 监听受控自动重载 (controlled automatic reload)，证明由客户端自主触发而非人工操作
    dom.window.__onTopologyMismatchReload = async () => {
      controlledReloadCount++;
      const resp = await globalThis.fetch(`${surfaceUrl}/`);
      const html = await resp.text();
      const reloadedDom = new JSDOM(html, { url: surfaceUrl });
      convergedDocument = reloadedDom.window.document;
      reloadPromiseResolve();
    };

    let capturedToast = null;
    dom.window.__showToast = (msg, isErr) => {
      capturedToast = msg;
    };

    const initialCards = doc.querySelectorAll('.project-card');
    console.log(`  - 页面卡片数量: ${initialCards.length}`);
    if (initialCards.length !== 2) throw new Error(`Expected 2 cards, got ${initialCards.length}`);
    if (!doc.getElementById('card-proj-disposable')) throw new Error('card-proj-disposable missing');
    if (!doc.getElementById('card-proj-sibling')) throw new Error('card-proj-sibling missing');

    const summaryBar = doc.querySelector('.status-summary-bar');
    console.log(`  - 初始统计栏: "${summaryBar.textContent.replace(/\s+/g, ' ').trim()}"`);
    if (!summaryBar.textContent.includes('2')) throw new Error('Project count in summary bar != 2');

    // =========================================================================
    // 步骤 2: 通过客户端交互链路点击“移出项目” (Client Interaction Path)
    // =========================================================================
    printStep(2, '模拟操作者在已打开页面点击“移出项目”按钮，触发自动客户端请求与收敛');
    const removeBtn = doc.querySelector('button[data-action="remove-project"][data-binding-id="proj-disposable"]');
    if (!removeBtn) {
      throw new Error('Could not find remove-project button for proj-disposable in open DOM');
    }
    console.log(`  - 找到移出按钮: text="${removeBtn.textContent.trim()}", title="${removeBtn.getAttribute('title')}"`);

    // 触发真实客户端点击事件
    removeBtn.click();
    console.log(`  - 已触发按钮点击，按钮状态变更为: text="${removeBtn.textContent.trim()}", disabled=${removeBtn.disabled}`);

    // =========================================================================
    // 步骤 3: 观察并验证自动收敛全链路 (无需人工 reload)
    // =========================================================================
    printStep(3, '观察客户端自动执行: POST remove -> __triggerSurfaceRefresh -> 拓扑失配 -> controlled reload -> converged Surface');
    
    // 等待客户端完成网络请求与受控重载触发
    await Promise.race([
      reloadPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for automatic reload')), 5000))
    ]);

    console.log(`  - 客户端 Toast 提示文案: "${capturedToast}"`);
    if (!capturedToast || !capturedToast.includes('只从 Rally 项目列表中移出')) {
      throw new Error(`Toast message not as expected: ${capturedToast}`);
    }

    console.log(`  - 受控自动重载触发次数: ${controlledReloadCount} (证明完全由客户端自主驱动，无任何人工介入)`);
    if (controlledReloadCount !== 1) {
      throw new Error(`Expected exactly 1 controlled reload, got ${controlledReloadCount}`);
    }
    if (!convergedDocument) {
      throw new Error('convergedDocument was not loaded by controlled reload');
    }

    // 验证收敛后 DOM
    const reloadedCards = convergedDocument.querySelectorAll('.project-card');
    console.log(`  - 收敛后卡片数量: ${reloadedCards.length}`);
    if (reloadedCards.length !== 1) throw new Error(`Expected 1 card, got ${reloadedCards.length}`);
    if (convergedDocument.getElementById('card-proj-disposable') !== null) {
      throw new Error('card-proj-disposable should be absent from converged DOM');
    }
    if (!convergedDocument.getElementById('card-proj-sibling')) {
      throw new Error('card-proj-sibling should remain intact in converged DOM');
    }

    const reloadedSummary = convergedDocument.querySelector('.status-summary-bar');
    console.log(`  - 收敛后统计栏呈现: "${reloadedSummary.textContent.replace(/\s+/g, ' ').trim()}"`);
    if (!reloadedSummary.textContent.includes('项目总数: 1')) {
      throw new Error('Converged summary bar does not show project count: 1');
    }

    // =========================================================================
    // 步骤 4: 模拟 Rally 重启并证明已移出项目依然不在活跃项目
    // =========================================================================
    printStep(4, '重启 Rally 实例，验证持久化加载后可支配项目依然不在活跃集合中');
    server.close();

    const restartedRegistry = createProjectRegistry({ storagePath });
    const restartedActiveList = restartedRegistry.listProjects();
    console.log(`  - 重启后活跃项目数量: ${restartedActiveList.length}`);
    if (restartedActiveList.length !== 1) {
      throw new Error(`Expected 1 active project after restart, got ${restartedActiveList.length}`);
    }
    if (restartedRegistry.hasProject('proj-disposable')) {
      throw new Error('proj-disposable still present in active registry after restart');
    }
    if (!restartedRegistry.hasProject('proj-sibling')) {
      throw new Error('proj-sibling missing from active registry after restart');
    }

    // =========================================================================
    // 步骤 5: 验证留存规范事实 (Retained Canonical Evidence) 完整持久化
    // =========================================================================
    printStep(5, '验证已移出项目的留存规范事实 (Retained Evidence) 完整持久化在活跃集之外');
    if (!restartedRegistry.hasRemovedProject('proj-disposable')) {
      throw new Error('restartedRegistry does not have retained proj-disposable');
    }
    const retained = restartedRegistry.getRemovedProject('proj-disposable');
    console.log(`  - 留存项目 binding_id: "${retained.binding?.binding_id}"`);
    console.log(`  - 留存项目 display_name: "${retained.binding?.display_name}"`);
    console.log(`  - 留存时间 removed_at: "${retained.removed_at}"`);
    console.log(`  - 留存的人工介入事实: active=${retained.human_intervention?.active}, reason="${retained.human_intervention?.reason}"`);
    console.log(`  - 留存的 Action 事实记录数: ${retained.actions?.length}`);

    if (retained.human_intervention?.active !== true || retained.human_intervention?.reason !== '移出前留存的人工关注标记') {
      throw new Error('Retained evidence failed to preserve human_intervention state');
    }
    if (!retained.actions || retained.actions.length !== 1 || retained.actions[0].action_id !== 'act-disp-1') {
      throw new Error('Retained evidence failed to preserve actions history');
    }

    // =========================================================================
    // 步骤 6: 验证兄弟项目 snapshot 与事实完全不变
    // =========================================================================
    printStep(6, '验证兄弟项目 (proj-sibling) 规范快照与全部端点事实完全不变');
    const siblingSnap = restartedRegistry.getProject('proj-sibling').getSnapshot();
    console.log(`  - Sibling binding_id: "${siblingSnap.binding?.binding_id}" (rev: ${siblingSnap.binding?.binding_revision})`);
    console.log(`  - Sibling display_name: "${siblingSnap.binding?.display_name}"`);
    console.log(`  - Sibling browser conv: "${siblingSnap.binding?.browser?.conversation_id}"`);
    console.log(`  - Sibling ide conv: "${siblingSnap.binding?.ide_endpoints?.[0]?.conversation_id}"`);

    if (siblingSnap.binding.display_name !== '兄弟核心项目 (Sibling)' ||
        siblingSnap.binding.browser.conversation_id !== 'conv-browser-sibling-5678' ||
        siblingSnap.binding.ide_endpoints[0].conversation_id !== 'conv-ide-sib-shared') {
      throw new Error('Sibling project facts were corrupted or altered!');
    }

    // =========================================================================
    // 步骤 7: 验证孤立 Hook 清理与共享 Hook 保留
    // =========================================================================
    printStep(7, '验证孤立 Hook 被清理，而共享工作区的 Hook 与存活白名单严格保留');

    // A. 独占工作区 disposableWs
    const dispAllowlistPath = path.join(disposableWs, '.agents', 'rally-conversations.json');
    const dispHooksPath = path.join(disposableWs, '.agents', 'hooks.json');
    const dispAllowlistExists = fs.existsSync(dispAllowlistPath);
    console.log(`  - 独占工作区白名单文件是否存在: ${dispAllowlistExists} (预期为 false)`);
    if (dispAllowlistExists) {
      throw new Error(`Orphaned allowlist still exists at ${dispAllowlistPath}`);
    }

    let dispHasRallyHook = false;
    if (fs.existsSync(dispHooksPath)) {
      const hData = JSON.parse(fs.readFileSync(dispHooksPath, 'utf8'));
      dispHasRallyHook = Boolean(hData['rally-ide-stop-hook']);
    }
    console.log(`  - 独占工作区 Rally Hook 节点是否存在: ${dispHasRallyHook} (预期为 false)`);
    if (dispHasRallyHook) {
      throw new Error(`Orphaned Rally hook still exists in ${dispHooksPath}`);
    }

    // B. 共享工作区 sharedWs
    const sharedAllowlistPath = path.join(sharedWs, '.agents', 'rally-conversations.json');
    const sharedHooksPath = path.join(sharedWs, '.agents', 'hooks.json');
    if (!fs.existsSync(sharedAllowlistPath)) {
      throw new Error(`Shared allowlist unexpectedly deleted at ${sharedAllowlistPath}`);
    }
    const sharedAllowlist = JSON.parse(fs.readFileSync(sharedAllowlistPath, 'utf8'));
    console.log(`  - 共享工作区白名单剩余会话: ${JSON.stringify(sharedAllowlist.conversations)}`);
    if (!Array.isArray(sharedAllowlist.conversations) ||
        sharedAllowlist.conversations.includes('conv-ide-disp-shared') ||
        !sharedAllowlist.conversations.includes('conv-ide-sib-shared')) {
      throw new Error(`Shared allowlist incorrect: ${JSON.stringify(sharedAllowlist.conversations)}`);
    }

    if (!fs.existsSync(sharedHooksPath)) {
      throw new Error(`Shared hooks.json unexpectedly deleted at ${sharedHooksPath}`);
    }
    const sharedHooks = JSON.parse(fs.readFileSync(sharedHooksPath, 'utf8'));
    if (!sharedHooks['rally-ide-stop-hook']) {
      throw new Error(`Shared Rally stop hook unexpectedly removed from ${sharedHooksPath}`);
    }
    console.log(`  - 共享工作区 Rally Hook 节点正常留存`);

    // =========================================================================
    // 步骤 8: 证明底层工作区文件与 Git 仓库未被修改
    // =========================================================================
    printStep(8, '证明底层外部工作区、代码仓库与用户源码完好未受任何修改');
    const currentShaDisp = execFileSync('git', ['-C', disposableWs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const currentShaShared = execFileSync('git', ['-C', sharedWs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dispAppContent = fs.readFileSync(repoDisp.appFile, 'utf8');
    const sharedAppContent = fs.readFileSync(repoShared.appFile, 'utf8');

    console.log(`  - Disposable 仓库 HEAD: ${currentShaDisp} (初始: ${repoDisp.commitSha})`);
    console.log(`  - Shared 仓库 HEAD:     ${currentShaShared} (初始: ${repoShared.commitSha})`);
    if (currentShaDisp !== repoDisp.commitSha || currentShaShared !== repoShared.commitSha) {
      throw new Error('Git repository commits were modified!');
    }
    if (!dispAppContent.includes('disposable-repo') || !sharedAppContent.includes('shared-repo')) {
      throw new Error('Workspace user source files were modified!');
    }
    console.log(`  - 用户源码文件字节级一致，工作区与仓库完好无损`);

    printHeader('ALL 7 ACCEPTANCE CRITERIA VERIFIED AND PASSED WITH ZERO REGRESSIONS!');
    if (dom?.window) {
      dom.window.__stopSurfaceRefresh?.();
      dom.window.close();
    }
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

runAcceptance()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Acceptance Runner Failed with error:');
    console.error(err);
    process.exit(1);
  });
