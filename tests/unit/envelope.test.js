import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAndValidateEnvelope } from '../../src/controller/envelope.js';
import { createBinding } from '../../src/controller/binding.js';

function makeTestBinding(rev = 1) {
  return createBinding({
    binding_id: 'bind-001',
    binding_revision: rev,
    browser: { provider: 'chatgpt', conversation_id: 'conv-browser' },
    ide: { conversation_id: 'conv-ide', workspace_identity: 'w1', repository_identity: 'r1' }
  });
}

test('[unit] Envelope: parses and validates valid envelope', () => {
  const text = `
Here is your envelope:
<RALLY_HANDOFF>
{
  "version": 1,
  "exchange_id": "ex-01",
  "nonce": "N_123",
  "binding_id": "bind-001",
  "binding_revision": 1,
  "operation": "rally.echo",
  "target": "bound_ide",
  "payload": {
    "text": "Return exactly RALLY_ECHO:N_123"
  }
}
</RALLY_HANDOFF>
Done.
  `;
  const parsed = extractAndValidateEnvelope(text, {
    expectedNonce: 'N_123',
    binding: makeTestBinding(1)
  });

  assert.equal(parsed.version, 1);
  assert.equal(parsed.nonce, 'N_123');
  assert.equal(parsed.operation, 'rally.echo');
  assert.equal(parsed.target, 'bound_ide');
  assert.equal(parsed.payload.text, 'Return exactly RALLY_ECHO:N_123');
});

test('[unit] Security Negative Test: JSON outside handoff block must be rejected', () => {
  const raw = 'Here is json outside: {"version": 1, "nonce": "N_1", "operation": "rally.echo", "target": "bound_ide", "payload": {"text": "hi"}}';
  assert.throws(() => {
    extractAndValidateEnvelope(raw, { expectedNonce: 'N_1' });
  }, /ENVELOPE_NOT_FOUND/);
});

test('[unit] Security Negative Test: Multiple handoff blocks must be rejected', () => {
  const raw = `
<RALLY_HANDOFF>
{"version": 1, "nonce": "N_1", "operation": "rally.echo", "target": "bound_ide", "payload": {"text": "first"}}
</RALLY_HANDOFF>
<RALLY_HANDOFF>
{"version": 1, "nonce": "N_1", "operation": "rally.echo", "target": "bound_ide", "payload": {"text": "second"}}
</RALLY_HANDOFF>
  `;
  assert.throws(() => {
    extractAndValidateEnvelope(raw, { expectedNonce: 'N_1' });
  }, /AMBIGUOUS_ENVELOPE/);
});

test('[unit] Security Negative Test: Unsupported operation must be rejected', () => {
  const raw = `
<RALLY_HANDOFF>
{
  "version": 1,
  "nonce": "N_1",
  "operation": "shell.exec",
  "target": "bound_ide",
  "payload": { "text": "rm -rf /" }
}
</RALLY_HANDOFF>
  `;
  assert.throws(() => {
    extractAndValidateEnvelope(raw, { expectedNonce: 'N_1' });
  }, /SECURITY_REJECT: Unsupported or unauthorized operation "shell.exec"/);
});

test('[unit] Security Negative Test: Nonce mismatch (old/historical or replayed turn)', () => {
  const raw = `
<RALLY_HANDOFF>
{
  "version": 1,
  "nonce": "HISTORICAL_NONCE_OLD",
  "operation": "rally.echo",
  "target": "bound_ide",
  "payload": { "text": "echo" }
}
</RALLY_HANDOFF>
  `;
  assert.throws(() => {
    extractAndValidateEnvelope(raw, { expectedNonce: 'FRESH_NONCE_NEW' });
  }, /VALIDATION_FAIL: Nonce mismatch/);
});

test('[unit] Security Negative Test: Stale binding revision', () => {
  const raw = `
<RALLY_HANDOFF>
{
  "version": 1,
  "nonce": "N_REV",
  "binding_id": "bind-001",
  "binding_revision": 1,
  "operation": "rally.echo",
  "target": "bound_ide",
  "payload": { "text": "echo" }
}
</RALLY_HANDOFF>
  `;
  assert.throws(() => {
    extractAndValidateEnvelope(raw, {
      expectedNonce: 'N_REV',
      binding: makeTestBinding(2) // binding is now at rev 2
    });
  }, /VALIDATION_FAIL: Stale binding revision/);
});

test('[unit] Security Negative Test: Wrong target', () => {
  const raw = `
<RALLY_HANDOFF>
{
  "version": 1,
  "nonce": "N_TARGET",
  "operation": "rally.echo",
  "target": "arbitrary_agent",
  "payload": { "text": "echo" }
}
</RALLY_HANDOFF>
  `;
  assert.throws(() => {
    extractAndValidateEnvelope(raw, { expectedNonce: 'N_TARGET' });
  }, /VALIDATION_FAIL: Invalid target/);
});

test('[unit] Security Negative Test: Unsupported envelope version', () => {
  const raw = `
<RALLY_HANDOFF>
{
  "version": 2,
  "nonce": "N_VER",
  "operation": "rally.echo",
  "target": "bound_ide",
  "payload": { "text": "echo" }
}
</RALLY_HANDOFF>
  `;
  assert.throws(() => {
    extractAndValidateEnvelope(raw, { expectedNonce: 'N_VER' });
  }, /VALIDATION_FAIL: Unsupported version 2/);
});
