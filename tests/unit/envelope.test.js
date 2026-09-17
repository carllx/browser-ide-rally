import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAndValidateEnvelope,
  formatEnvelopeBlock,
  SUPPORTED_ENVELOPE_VERSION,
  ALLOWED_OPERATIONS
} from '../../src/controller/envelope.js';

test('[Envelope] 1. 成功解析并校验包含精准端点目标与版本的 Envelope', () => {
  const rawEnvelope = {
    version: 1,
    nonce: 'nonce-abc-123',
    binding_id: 'proj-alpha',
    binding_revision: 3,
    target_endpoint: 'ide-primary',
    operation: 'rally.echo',
    payload: {
      text: 'Echo test message'
    }
  };

  const blockText = formatEnvelopeBlock(rawEnvelope);
  assert.match(blockText, /<RALLY_HANDOFF>/);
  assert.match(blockText, /<\/RALLY_HANDOFF>/);

  const parsed = extractAndValidateEnvelope(blockText, {
    expectedNonce: 'nonce-abc-123',
    expectedBindingId: 'proj-alpha',
    expectedBindingRevision: 3,
    expectedTargetEndpoint: 'ide-primary'
  });

  assert.equal(parsed.version, 1);
  assert.equal(parsed.nonce, 'nonce-abc-123');
  assert.equal(parsed.binding_id, 'proj-alpha');
  assert.equal(parsed.binding_revision, 3);
  assert.equal(parsed.target_endpoint, 'ide-primary');
  assert.equal(parsed.operation, 'rally.echo');
  assert.equal(parsed.payload.text, 'Echo test message');
});

test('[Envelope] 2. 拒绝泛化 bound_ide，强制要求精准 target_endpoint', () => {
  const genericEnvelope = {
    version: 1,
    nonce: 'nonce-generic',
    binding_id: 'proj-alpha',
    binding_revision: 1,
    target: 'bound_ide', // 历史旧字段，被禁止使用
    operation: 'rally.echo',
    payload: { text: 'test' }
  };

  const blockText = formatEnvelopeBlock(genericEnvelope);
  assert.throws(() => {
    extractAndValidateEnvelope(blockText, {
      expectedBindingRevision: 1
    });
  }, /Mandatory target_endpoint is required and must not be generic bound_ide/);
});

test('[Envelope] 3. 严格拦截过期或缺失的 binding_revision (Stale/Missing Revision Guard)', () => {
  const validEnvelope = {
    version: 1,
    nonce: 'nonce-rev-test',
    binding_id: 'proj-alpha',
    binding_revision: 2,
    target_endpoint: 'ide-a',
    operation: 'rally.echo',
    payload: { text: 'test' }
  };

  const blockText = formatEnvelopeBlock(validEnvelope);

  // 1. 缺失期望版本 -> 抛错
  assert.throws(() => {
    extractAndValidateEnvelope(blockText, {
      expectedBindingRevision: undefined
    });
  }, /expectedBindingRevision is required/);

  // 2. 版本过期或失配 -> 抛错
  assert.throws(() => {
    extractAndValidateEnvelope(blockText, {
      expectedBindingRevision: 3 // 当前项目已经演进到 rev 3
    });
  }, /Stale or mismatched binding revision/);
});

test('[Envelope] 4. 严格拦截非白名单指令与恶意负载 (防任意 Web 文本注入 Shell)', () => {
  const maliciousEnvelope = {
    version: 1,
    nonce: 'nonce-hack',
    binding_id: 'proj-alpha',
    binding_revision: 1,
    target_endpoint: 'ide-a',
    operation: 'shell.exec', // 恶意非白名单指令
    payload: { command: 'rm -rf /' }
  };

  const blockText = formatEnvelopeBlock(maliciousEnvelope);
  assert.throws(() => {
    extractAndValidateEnvelope(blockText, {
      expectedBindingRevision: 1
    });
  }, /SECURITY_REJECT: Unsupported or unauthorized operation/);
});

test('[Envelope] 5. 单轮次中存在多个或歧义 Envelope 时 Fail-Closed', () => {
  const multiBlock = `
    <RALLY_HANDOFF>
    {"version":1,"nonce":"n1","binding_id":"p","binding_revision":1,"target_endpoint":"ide-a","operation":"rally.echo","payload":{"text":"1"}}
    </RALLY_HANDOFF>
    some text
    <RALLY_HANDOFF>
    {"version":1,"nonce":"n2","binding_id":"p","binding_revision":1,"target_endpoint":"ide-a","operation":"rally.echo","payload":{"text":"2"}}
    </RALLY_HANDOFF>
  `;

  assert.throws(() => {
    extractAndValidateEnvelope(multiBlock, {
      expectedBindingRevision: 1
    });
  }, /AMBIGUOUS_ENVELOPE/);
});
