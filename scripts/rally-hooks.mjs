#!/usr/bin/env node

/**
 * Rally Workspace Hooks 管理与清理命令行工具
 * 
 * 用法：
 *   node scripts/rally-hooks.mjs cleanup    # 从所有已注册工作区清理 Rally Stop Hook 与白名单
 *   node scripts/rally-hooks.mjs reconcile  # 从持久化注册表真值重建所有工作区 Hook 与白名单
 *   node scripts/rally-hooks.mjs status     # 查看当前各工作区的 Hook 与白名单配置状态
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceHookManager } from '../src/runtime/workspace-hook-manager.js';
import { createProjectRegistry } from '../src/registry/project-registry.js';

const DEFAULT_STORAGE_PATH = path.join(os.homedir(), '.browser-ide-rally', 'projects.json');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  const registry = createProjectRegistry();
  if (fs.existsSync(DEFAULT_STORAGE_PATH)) {
    try {
      registry.loadFromFile(DEFAULT_STORAGE_PATH);
    } catch (err) {
      console.warn(`[rally-hooks] Warning: Failed to load registry from ${DEFAULT_STORAGE_PATH}: ${err.message}`);
    }
  }

  const manager = new WorkspaceHookManager({ logger: console });

  if (command === 'cleanup') {
    console.log('[rally-hooks] Cleaning up all Rally workspace hooks...');
    const res = manager.cleanupAllWorkspaceHooks(registry);
    console.log(`[rally-hooks] Successfully cleaned up ${res.cleanedWorkspaces} workspace(s).`);
    process.exit(0);
  }

  if (command === 'reconcile') {
    console.log('[rally-hooks] Reconciling workspace hooks from canonical registry...');
    const res = manager.reconcileWorkspaceHooks(registry);
    console.log(`[rally-hooks] Reconciled ${res.reconciledWorkspaces} workspace(s). Errors: ${res.errors.length}`);
    if (res.errors.length > 0) {
      res.errors.forEach(e => console.error(` - ${e}`));
    }
    process.exit(0);
  }

  if (command === 'status') {
    const projects = registry.listProjects();
    console.log(`[rally-hooks] Active projects in registry: ${projects.length}`);
    const stableBridge = manager.getStableBridgePath();
    console.log(`[rally-hooks] Stable bridge: ${stableBridge} (exists: ${fs.existsSync(stableBridge)})`);

    for (const snap of projects) {
      console.log(`\nProject: ${snap.binding.display_name} (${snap.binding.binding_id})`);
      const ideEps = snap.binding.ide_endpoints || [];
      for (const ep of ideEps) {
        const ws = ep.workspace_identity;
        const conv = ep.conversation_id;
        const hookJson = path.join(ws, '.agents', 'hooks.json');
        const allowlistJson = path.join(ws, '.agents', 'rally-conversations.json');
        console.log(`  - IDE endpoint: ${ep.endpoint_id}`);
        console.log(`    Workspace: ${ws}`);
        console.log(`    Conversation: ${conv}`);
        console.log(`    Hook file exists: ${fs.existsSync(hookJson)}`);
        console.log(`    Allowlist exists: ${fs.existsSync(allowlistJson)}`);
      }
    }
    process.exit(0);
  }

  console.error(`Unknown command "${command}". Available commands: cleanup, reconcile, status`);
  process.exit(1);
}

main();
