import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASES,
  createExchange,
  transitionExchange,
  markBlocked,
  markUnknownDelivery
} from '../../src/controller/exchange.js';

test('[unit] Exchange: lifecycle happy path transitions', () => {
  const ex = createExchange({
    exchange_id: 'ex-101',
    nonce: 'N-101',
    binding_id: 'bind-001',
    binding_revision: 1
  });

  assert.equal(ex.phase, PHASES.PREPARED);

  transitionExchange(ex, PHASES.VALIDATED, { evidence: 'Validated' });
  assert.equal(ex.phase, PHASES.VALIDATED);

  transitionExchange(ex, PHASES.DELIVERED_TO_IDE, { evidence: 'Sent to IDE' });
  assert.equal(ex.phase, PHASES.DELIVERED_TO_IDE);

  transitionExchange(ex, PHASES.RESULT_OBSERVED, { evidence: 'Observed artifact' });
  assert.equal(ex.phase, PHASES.RESULT_OBSERVED);

  transitionExchange(ex, PHASES.DELIVERED_TO_BROWSER, { evidence: 'Delivered to browser' });
  assert.equal(ex.phase, PHASES.DELIVERED_TO_BROWSER);

  transitionExchange(ex, PHASES.BROWSER_ACKNOWLEDGED, { evidence: 'ACK received' });
  assert.equal(ex.phase, PHASES.BROWSER_ACKNOWLEDGED);
  assert.equal(ex.needs_human, false);
});

test('[unit] Exchange: illegal transition throws error', () => {
  const ex = createExchange({
    exchange_id: 'ex-102',
    nonce: 'N-102',
    binding_id: 'bind-001',
    binding_revision: 1
  });

  // Cannot jump directly from PREPARED to BROWSER_ACKNOWLEDGED
  assert.throws(() => {
    transitionExchange(ex, PHASES.BROWSER_ACKNOWLEDGED);
  }, /Invalid exchange transition/);
});

test('[unit] Security Negative Test: Unknown delivery marks human gate and stops automatic retry', () => {
  const ex = createExchange({
    exchange_id: 'ex-103',
    nonce: 'N-103',
    binding_id: 'bind-001',
    binding_revision: 1
  });

  transitionExchange(ex, PHASES.VALIDATED);
  markUnknownDelivery(ex, 'IDE network connection dropped after send');

  assert.equal(ex.phase, PHASES.UNKNOWN_DELIVERY);
  assert.equal(ex.needs_human, true);
  assert.match(ex.blocker, /IDE network connection dropped/);

  // Terminal state: cannot transition further
  assert.throws(() => {
    transitionExchange(ex, PHASES.DELIVERED_TO_IDE);
  }, /Invalid exchange transition/);
});

test('[unit] Exchange: markBlocked halts progression and sets blocker', () => {
  const ex = createExchange({
    exchange_id: 'ex-104',
    nonce: 'N-104',
    binding_id: 'bind-001',
    binding_revision: 1
  });

  markBlocked(ex, 'Operator initiated pause', { needs_human: true });
  assert.equal(ex.phase, PHASES.BLOCKED);
  assert.equal(ex.needs_human, true);
  assert.equal(ex.blocker, 'Operator initiated pause');
});
