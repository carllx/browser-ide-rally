/**
 * WorkspaceHookManager: 管理参与 Rally 的工作区本地 Antigravity Stop Hook 及其订阅白名单生命周期
 * 
 * 核心契约：
 * 1. 严格工作区级作用域 (Workspace-Scoped)：绝不安装全局 hook，仅在明确参与 Rally 的工作区内管理；
 * 2. 本地订阅边界 (Subscription Allowlist)：每个工作区维护一份 .agents/rally-conversations.json；
 * 3. 避免源码污染 (Git Cleanliness)：通过 .git/info/exclude 排除本地 Hook 与白名单，严禁修改 .gitignore；
 * 4. 已跟踪文件守卫 (Tracked Hook Protection)：若目标工作区的 .agents/hooks.json 已被 Git 跟踪，拒绝静默修改，Fail-Closed 返回 WORKSPACE_HOOK_REQUIRES_USER_DECISION；
 * 5. 用户级稳定 Bridge：统一指向 ~/.browser-ide-rally/bin/antigravity-stop-hook.mjs，目标工作区不复制执行脚本；
 * 6. 幂等与独立共存：增删仅修改 rally-ide-stop-hook 节点，严格保留用户已有的其它第三方 hooks。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BRIDGE_SOURCE = path.resolve(__dirname, '../../scripts/antigravity-stop-hook.mjs');
const DEFAULT_BIN_DIR = path.join(os.homedir(), '.browser-ide-rally', 'bin');
const HOOK_KEY = 'rally-ide-stop-hook';

export class WorkspaceHookManager {
  /**
   * @param {object} [options]
   * @param {string} [options.binDir] - 稳定桥接脚本安装目录
   * @param {string} [options.bridgeSourcePath] - 桥接脚本源码路径
   * @param {object} [options.logger=console] - 日志输出器
   */
  constructor({
    binDir = DEFAULT_BIN_DIR,
    bridgeSourcePath = DEFAULT_BRIDGE_SOURCE,
    logger = console
  } = {}) {
    this._binDir = path.resolve(binDir);
    this._bridgeSourcePath = path.resolve(bridgeSourcePath);
    this._logger = logger;
  }

  /**
   * 获取用户级稳定 Bridge 脚本路径
   * @returns {string}
   */
  getStableBridgePath() {
    return path.join(this._binDir, 'antigravity-stop-hook.mjs');
  }

  /**
   * 确保用户级稳定 Bridge 脚本存在且内容最新
   * @returns {string} 稳定 bridge 的绝对路径
   */
  ensureStableBridge() {
    const bridgePath = this.getStableBridgePath();
    try {
      if (!fs.existsSync(this._binDir)) {
        fs.mkdirSync(this._binDir, { recursive: true });
      }

      if (!fs.existsSync(this._bridgeSourcePath)) {
        throw new Error(`Bridge source script not found at ${this._bridgeSourcePath}`);
      }

      const sourceContent = fs.readFileSync(this._bridgeSourcePath, 'utf8');
      let needsWrite = true;
      if (fs.existsSync(bridgePath)) {
        const existingContent = fs.readFileSync(bridgePath, 'utf8');
        if (existingContent === sourceContent) {
          needsWrite = false;
        }
      }

      if (needsWrite) {
        fs.writeFileSync(bridgePath, sourceContent, { encoding: 'utf8', mode: 0o755 });
      }
    } catch (err) {
      this._logger?.error?.(`[WorkspaceHookManager] Failed to ensure stable bridge: ${err.message}`);
      throw err;
    }
    return bridgePath;
  }

  /**
   * 检查目标工作区内 .agents/hooks.json 是否已被 Git 跟踪
   * @param {string} workspacePath
   * @returns {boolean}
   */
  isHookTrackedByGit(workspacePath) {
    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      return false;
    }
    try {
      const out = execFileSync('git', ['-C', workspacePath, 'ls-files', '.agents/hooks.json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return out.length > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * 通过 .git/info/exclude 确保工作区内 Rally 专有产物不造成 git dirty 状态
   * 严格仅排除专有文件，绝不泛化排除整个 .agents 目录，绝不修改 tracked .gitignore
   * @param {string} workspacePath
   */
  ensureGitExclusion(workspacePath) {
    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      return;
    }

    try {
      let infoDir = path.join(gitDir, 'info');
      if (fs.statSync(gitDir).isFile()) {
        // 支持 Git worktree / submodule 文件形式的 .git
        const gitContent = fs.readFileSync(gitDir, 'utf8');
        const match = gitContent.match(/gitdir:\s*(.+)/);
        if (match) {
          const realGitDir = path.resolve(workspacePath, match[1].trim());
          infoDir = path.join(realGitDir, 'info');
        }
      }

      if (!fs.existsSync(infoDir)) {
        fs.mkdirSync(infoDir, { recursive: true });
      }

      const excludePath = path.join(infoDir, 'exclude');
      let excludeContent = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';

      const linesToAdd = [];
      if (!excludeContent.includes('.agents/hooks.json')) {
        linesToAdd.push('.agents/hooks.json');
      }
      if (!excludeContent.includes('.agents/rally-conversations.json')) {
        linesToAdd.push('.agents/rally-conversations.json');
      }
      if (!excludeContent.includes('.agents/hook-url')) {
        linesToAdd.push('.agents/hook-url');
      }

      if (linesToAdd.length > 0) {
        const prefix = excludeContent.length > 0 && !excludeContent.endsWith('\n') ? '\n' : '';
        const appendText = `${prefix}# Rally workspace-local transport & subscription artifacts\n${linesToAdd.join('\n')}\n`;
        fs.appendFileSync(excludePath, appendText, 'utf8');
      }
    } catch (err) {
      this._logger?.warn?.(`[WorkspaceHookManager] Failed to update .git/info/exclude in ${workspacePath}: ${err.message}`);
    }
  }

  _readAllowlist(allowlistPath) {
    if (!fs.existsSync(allowlistPath)) {
      return { conversations: [] };
    }
    try {
      const data = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
      return {
        conversations: Array.isArray(data?.conversations) ? data.conversations : [],
        updated_at: data?.updated_at || null
      };
    } catch (_) {
      return { conversations: [] };
    }
  }

  /**
   * 确保目标工作区具备 Rally Stop Hook 并将指定会话录入白名单
   * @param {string} workspacePath
   * @param {string} conversationId
   * @returns {{ success: boolean, reason?: string, workspacePath?: string, conversationId?: string }}
   */
  ensureWorkspaceHook(workspacePath, conversationId, { surfaceUrl = null } = {}) {
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { success: false, reason: 'invalid_workspace_path' };
    }
    const cleanConvId = conversationId ? String(conversationId).trim() : null;
    if (!cleanConvId) {
      return { success: false, reason: 'missing_conversation_id' };
    }

    const resolvedWs = path.resolve(workspacePath);
    if (!fs.existsSync(resolvedWs)) {
      return { success: false, reason: 'workspace_directory_not_found' };
    }

    // 1. 检查已跟踪守卫 (Tracked Hook Protection)
    if (this.isHookTrackedByGit(resolvedWs)) {
      this._logger?.warn?.(
        `[WorkspaceHookManager] .agents/hooks.json in ${resolvedWs} is tracked by Git. Refusing to modify.`
      );
      return {
        success: false,
        reason: 'WORKSPACE_HOOK_REQUIRES_USER_DECISION',
        workspacePath: resolvedWs,
        conversationId: cleanConvId
      };
    }

    // 2. 确保稳定桥接可用
    const bridgePath = this.ensureStableBridge();

    // 3. 配置 Git 本地排除，确保零 Git 污染
    this.ensureGitExclusion(resolvedWs);

    // 4. 更新 .agents/hooks.json
    const agentsDir = path.join(resolvedWs, '.agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }

    const hooksJsonPath = path.join(agentsDir, 'hooks.json');
    let hooksData = {};
    if (fs.existsSync(hooksJsonPath)) {
      try {
        hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      } catch (_) {
        hooksData = {};
      }
    }

    const hookCommand = surfaceUrl
      ? `node "${bridgePath}" --url "${surfaceUrl}"`
      : `node "${bridgePath}"`;

    // 注入/更新 Rally Stop Hook 节点（严格保留其它 tool 配置）
    hooksData[HOOK_KEY] = {
      Stop: [
        {
          type: 'command',
          command: hookCommand,
          timeout: 5
        }
      ]
    };

    fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksData, null, 2) + '\n', 'utf8');

    // 5. 更新 .agents/rally-conversations.json 本地会话白名单
    const allowlistPath = path.join(agentsDir, 'rally-conversations.json');
    const allowlistData = this._readAllowlist(allowlistPath);

    const convs = Array.isArray(allowlistData.conversations) ? allowlistData.conversations : [];
    const isNewSubscription = !convs.includes(cleanConvId);
    if (isNewSubscription) {
      convs.push(cleanConvId);
    }
    allowlistData.conversations = convs;
    allowlistData.updated_at = new Date().toISOString();

    fs.writeFileSync(allowlistPath, JSON.stringify(allowlistData, null, 2) + '\n', 'utf8');

    return {
      success: true,
      workspacePath: resolvedWs,
      conversationId: cleanConvId,
      newlySubscribed: isNewSubscription
    };
  }

  /**
   * 从目标工作区移除指定会话订阅；若白名单清空，则彻底清理 Rally 专有 Hook
   * @param {string} workspacePath
   * @param {string} conversationId
   * @returns {{ success: boolean, remaining?: number, removedHook?: boolean }}
   */
  removeWorkspaceHook(workspacePath, conversationId) {
    if (!workspacePath || !conversationId) {
      return { success: false, reason: 'missing_arguments' };
    }

    const resolvedWs = path.resolve(workspacePath);
    const agentsDir = path.join(resolvedWs, '.agents');
    const allowlistPath = path.join(agentsDir, 'rally-conversations.json');
    const cleanConvId = String(conversationId).trim();

    if (!fs.existsSync(allowlistPath)) {
      return { success: true, remaining: 0, removedHook: false };
    }

    const allowlistData = this._readAllowlist(allowlistPath);
    const existingConvs = Array.isArray(allowlistData.conversations) ? allowlistData.conversations : [];
    const remainingConvs = existingConvs.filter(id => id !== cleanConvId);

    if (remainingConvs.length > 0) {
      allowlistData.conversations = remainingConvs;
      allowlistData.updated_at = new Date().toISOString();
      fs.writeFileSync(allowlistPath, JSON.stringify(allowlistData, null, 2) + '\n', 'utf8');
      return { success: true, remaining: remainingConvs.length, removedHook: false };
    }

    // 白名单已清空：清理白名单文件与 Rally Hook
    try {
      fs.unlinkSync(allowlistPath);
    } catch (_) {}

    const hooksJsonPath = path.join(agentsDir, 'hooks.json');
    let removedHook = false;
    if (fs.existsSync(hooksJsonPath)) {
      try {
        const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
        if (hooksData[HOOK_KEY]) {
          delete hooksData[HOOK_KEY];
          removedHook = true;
          if (Object.keys(hooksData).length === 0) {
            fs.unlinkSync(hooksJsonPath);
          } else {
            fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksData, null, 2) + '\n', 'utf8');
          }
        }
      } catch (_) {}
    }

    // 若 .agents 目录变空，清理该目录
    try {
      const remainingFiles = fs.readdirSync(agentsDir);
      if (remainingFiles.length === 0) {
        fs.rmdirSync(agentsDir);
      }
    } catch (_) {}

    return { success: true, remaining: 0, removedHook };
  }

  /**
   * 辅助方法：从 ProjectRegistry 派生所有活跃工作区及其绑定的会话集合
   * @private
   * @param {import('../registry/project-registry.js').ProjectRegistry} registry
   * @returns {Map<string, Set<string>>} workspacePath -> Set<conversationId>
   */
  _extractActiveWorkspaces(registry) {
    const snapshots = registry.listProjects();
    const workspaceMap = new Map();

    for (const snap of snapshots) {
      const ideEndpoints = snap.binding?.ide_endpoints || [];
      for (const ep of ideEndpoints) {
        const ws = ep.workspace_identity;
        const convId = ep.conversation_id;
        if (ws && convId) {
          const resolvedWs = path.resolve(ws);
          if (!workspaceMap.has(resolvedWs)) {
            workspaceMap.set(resolvedWs, new Set());
          }
          workspaceMap.get(resolvedWs).add(convId.trim());
        }
      }
    }

    return workspaceMap;
  }

  /**
   * 根据 ProjectRegistry 的权威真值，重建所有活跃工作区的 Hook 与订阅白名单
   * @param {import('../registry/project-registry.js').ProjectRegistry} registry
   * @returns {{ reconciledWorkspaces: number, errors: string[] }}
   */
  reconcileWorkspaceHooks(registry) {
    if (!registry || typeof registry.listProjects !== 'function') {
      return { reconciledWorkspaces: 0, errors: ['invalid_registry'] };
    }

    this.ensureStableBridge();

    const workspaceMap = this._extractActiveWorkspaces(registry);
    let reconciledCount = 0;
    const errors = [];

    for (const [ws, convSet] of workspaceMap.entries()) {
      if (!fs.existsSync(ws)) continue;

      // 1. 确保活跃会话均被安装
      for (const convId of convSet) {
        const res = this.ensureWorkspaceHook(ws, convId);
        if (!res.success) {
          errors.push(`Workspace ${ws} conv ${convId}: ${res.reason}`);
        }
      }

      // 2. 修剪白名单中已失效的历史会话，与权威真值严格对齐
      const allowlistPath = path.join(ws, '.agents', 'rally-conversations.json');
      const currentAllowlist = this._readAllowlist(allowlistPath);
      const staleConvs = currentAllowlist.conversations.filter(id => !convSet.has(id));
      for (const staleId of staleConvs) {
        this.removeWorkspaceHook(ws, staleId);
      }

      reconciledCount++;
    }

    return { reconciledWorkspaces: reconciledCount, errors };
  }

  /**
   * 清理当前 Registry 中所有已知的 Rally 工作区 Hooks
   * @param {import('../registry/project-registry.js').ProjectRegistry} registry
   */
  cleanupAllWorkspaceHooks(registry) {
    if (!registry || typeof registry.listProjects !== 'function') {
      return { cleanedWorkspaces: 0 };
    }

    const workspaceMap = this._extractActiveWorkspaces(registry);
    let count = 0;
    for (const [ws, convSet] of workspaceMap.entries()) {
      for (const convId of convSet) {
        this.removeWorkspaceHook(ws, convId);
      }
      count++;
    }

    return { cleanedWorkspaces: count };
  }
}
