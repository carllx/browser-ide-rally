#!/usr/bin/env node
/**
 * 启动本地 Rally 状态表面服务 (Rally Status Surface Runner)
 * 依赖 node:http 原生轻量服务，提供最小、可复现的本地查看与交互入口
 */

import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../src/registry/project-registry.js';
import { startStatusSurfaceServer } from '../src/surface/surface-server.js';

function parseArgs(args) {
  const options = {
    port: parseInt(process.env.PORT, 10) || 3123,
    storage: null
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--storage' && args[i + 1]) {
      options.storage = path.resolve(process.cwd(), args[i + 1]);
      i++;
    }
  }
  return options;
}

function populateDemoRegistry(registry) {
  // 1. Triple NEW 项目
  const core1 = registry.registerProject({
    binding: {
      binding_id: 'rally-core-service',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'conv-browser-service-001' },
      ide_endpoints: [
        {
          endpoint_id: 'ide-primary',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-primary-001',
          workspace_identity: '/Users/rally/workspace/browser-ide-rally',
          repository_identity: 'github.com/carllx/browser-ide-rally'
        },
        {
          endpoint_id: 'ide-worker',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-worker-002',
          workspace_identity: '/Users/rally/workspace/browser-ide-rally',
          repository_identity: 'github.com/carllx/browser-ide-rally'
        }
      ],
      capabilities: ['read', 'write'],
      paused: false
    }
  });

  core1.recordEndpointObservation('browser', {
    trusted: true,
    latest_completed_cursor: 'cur-browser-101',
    provider: 'chatgpt',
    conversation_id: 'conv-browser-service-001',
    endpoint_revision: 1
  });
  core1.recordEndpointObservation('ide-primary', {
    trusted: true,
    latest_completed_cursor: 'cur-ide-primary-201',
    endpoint_id: 'ide-primary',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-primary-001',
    workspace_identity: '/Users/rally/workspace/browser-ide-rally',
    repository_identity: 'github.com/carllx/browser-ide-rally'
  });
  core1.recordEndpointObservation('ide-worker', {
    trusted: true,
    latest_completed_cursor: 'cur-ide-worker-301',
    endpoint_id: 'ide-worker',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-worker-002',
    workspace_identity: '/Users/rally/workspace/browser-ide-rally',
    repository_identity: 'github.com/carllx/browser-ide-rally'
  });

  // 2. Sibling NEW + UNKNOWN 演示项目
  const core2 = registry.registerProject({
    binding: {
      binding_id: 'rally-staging-service',
      binding_revision: 1,
      browser: { provider: 'chatgpt', conversation_id: 'conv-browser-staging-002' },
      ide_endpoints: [
        {
          endpoint_id: 'ide-tester-a',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-tester-a',
          workspace_identity: '/Users/rally/staging/browser-ide-rally',
          repository_identity: 'github.com/carllx/browser-ide-rally'
        },
        {
          endpoint_id: 'ide-tester-b',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-tester-b',
          workspace_identity: '/Users/rally/staging/browser-ide-rally',
          repository_identity: 'github.com/carllx/browser-ide-rally'
        }
      ],
      capabilities: ['read'],
      paused: false
    }
  });

  core2.recordEndpointObservation('ide-tester-a', {
    trusted: true,
    latest_completed_cursor: 'cur-tester-a-501',
    endpoint_id: 'ide-tester-a',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-tester-a',
    workspace_identity: '/Users/rally/staging/browser-ide-rally',
    repository_identity: 'github.com/carllx/browser-ide-rally'
  });
  core2.recordEndpointObservation('ide-tester-b', {
    continuity_lost: true,
    reason: 'continuity_lost: agent disconnected',
    endpoint_id: 'ide-tester-b',
    endpoint_revision: 1,
    conversation_id: 'conv-ide-tester-b',
    workspace_identity: '/Users/rally/staging/browser-ide-rally',
    repository_identity: 'github.com/carllx/browser-ide-rally'
  });

  // 3. 人工介入与 Action 事实演示项目
  const core3 = registry.registerProject({
    binding: {
      binding_id: 'rally-production-gate',
      binding_revision: 3,
      browser: { provider: 'chatgpt', conversation_id: 'conv-browser-prod-003' },
      ide_endpoints: [
        {
          endpoint_id: 'ide-release-agent',
          endpoint_revision: 1,
          conversation_id: 'conv-ide-release-001',
          workspace_identity: '/Users/rally/prod/release',
          repository_identity: 'github.com/carllx/browser-ide-rally'
        }
      ],
      capabilities: ['read', 'write'],
      paused: false
    }
  });

  core3.setHumanIntervention({ active: true, reason: 'Release tag v0.4.0 requires manual sign-off' });
  core3.recordActionFact({
    action_id: 'act-release-check',
    action_type: 'verify',
    target_endpoint: 'ide-release-agent',
    stage: 'REQUESTED'
  });
  core3.recordActionFact({
    action_id: 'act-changelog-dispatch',
    action_type: 'relay',
    target_endpoint: 'browser',
    stage: 'ACCEPTED_OR_DELIVERED'
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let registry;

  if (options.storage && fs.existsSync(options.storage)) {
    registry = createProjectRegistry({ storagePath: options.storage });
    console.log(`[Rally] Loaded registry from ${options.storage} (${registry.listProjects().length} projects)`);
  } else {
    registry = createProjectRegistry({ storagePath: options.storage });
    populateDemoRegistry(registry);
    console.log(`[Rally] Initialized in-memory demo registry with 3 sample projects`);
  }

  const { url, close } = await startStatusSurfaceServer({
    registry,
    port: options.port,
    host: '127.0.0.1'
  });

  console.log(`[Rally] Status Surface listening at ${url}`);
  console.log(`[Rally] Press Ctrl+C to shut down.`);

  const shutdown = async () => {
    console.log('\n[Rally] Shutting down Status Surface...');
    await close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 仅在直接执行时启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(err => {
    console.error(`[Rally] Failed to start status surface:`, err);
    process.exit(1);
  });
}

export { main, populateDemoRegistry };
