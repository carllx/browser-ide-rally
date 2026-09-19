import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { createBinding } from '../../src/controller/binding.js';

export function setupMultiEndpointFixture() {
  const registry = createProjectRegistry();
  const binding = createBinding({
    binding_id: 'proj-continue-1',
    binding_revision: 1,
    browser: {
      provider: 'chatgpt',
      conversation_id: 'conv-br-1',
      branch: 'mainline'
    },
    ide_endpoints: [
      {
        endpoint_id: 'ide-1',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-1',
        workspace_identity: '/workspaces/proj',
        repository_identity: 'carllx/browser-ide-rally'
      },
      {
        endpoint_id: 'ide-2',
        endpoint_revision: 1,
        conversation_id: 'conv-ide-2',
        workspace_identity: '/workspaces/proj-2',
        repository_identity: 'carllx/browser-ide-rally'
      }
    ]
  });
  const core = registry.registerProject({ binding });
  return { registry, core, binding };
}

export function createMockBrowserAdapter(dispatchedPrompts = []) {
  return {
    sendTextPrompt: (conversationId, text) => {
      dispatchedPrompts.push({ conversationId, text });
      return { delivery_proven: true, delivery_evidence: 'Mock browser prompt delivered' };
    },
    checkComposerPreflight: () => ({ ready: true })
  };
}

export function createMockIdeAdapter(dispatchedTasks = []) {
  return {
    verifyTargetIdentity: () => true,
    dispatchControlledTask: ({ conversationId, envelope, targetEndpoint }) => {
      dispatchedTasks.push({ conversationId, envelope, targetEndpoint });
      return { delivery_proven: true, delivery_evidence: 'Mock IDE task delivered' };
    }
  };
}
