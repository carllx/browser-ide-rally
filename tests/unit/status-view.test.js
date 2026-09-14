import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinding } from '../../src/controller/binding.js';
import { createExchange, transitionExchange, PHASES } from '../../src/controller/exchange.js';
import { formatStatusDump, formatCompactStatus } from '../../src/status/status-view.js';

test('[unit] StatusView: formats machine-readable dump and compact text', () => {
  const binding = createBinding({
    binding_id: 'bind-001',
    binding_revision: 3,
    browser: { provider: 'chatgpt', conversation_id: 'conv-br' },
    ide: { conversation_id: 'conv-ide', workspace_identity: 'file:///ws', repository_identity: 'carllx/browser-ide-rally' }
  });

  const exchange = createExchange({
    exchange_id: 'ex-104',
    nonce: 'N-104',
    binding_id: 'bind-001',
    binding_revision: 3
  });

  transitionExchange(exchange, PHASES.VALIDATED);
  transitionExchange(exchange, PHASES.DELIVERED_TO_IDE, {
    evidence: 'agentapi accepted @ 2026-09-15T07:00:00Z'
  });

  const dump = formatStatusDump(binding, exchange);
  assert.equal(dump.binding.binding_id, 'bind-001');
  assert.equal(dump.binding.binding_revision, 3);
  assert.equal(dump.exchange.phase, PHASES.DELIVERED_TO_IDE);
  assert.equal(dump.exchange.needs_human, false);

  const compact = formatCompactStatus(binding, exchange);
  assert.ok(compact.includes('Binding bind-001 rev=3'));
  assert.ok(compact.includes('Phase delivered_to_ide'));
  assert.ok(compact.includes('Paused false'));
  assert.ok(compact.includes('Human no'));
  assert.ok(compact.includes('Blocker none'));
  assert.ok(compact.includes('agentapi accepted'));
});
