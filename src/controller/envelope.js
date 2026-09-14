/**
 * Typed Handoff Envelope 解析器与安全校验器
 * 负责从 Browser Assistant 消息中提取 <RALLY_HANDOFF> 块并进行严格安全验证
 */

export const SUPPORTED_ENVELOPE_VERSION = 1;
export const ALLOWED_OPERATIONS = ['rally.echo'];
export const VALID_TARGET = 'bound_ide';

/**
 * 提取并校验 Envelope
 * 
 * @param {string} rawText - 包含 <RALLY_HANDOFF> 标签的消息文本
 * @param {object} options
 * @param {string} options.expectedNonce - 期望的 fresh nonce
 * @param {object} [options.binding] - 可选的关联 Binding 记录 (用于 revision / binding_id / capabilities 校验)
 * @param {string} [options.expectedExchangeId] - 可选的期望 exchange_id
 * @returns {object} 校验通过的结构化 envelope
 */
export function extractAndValidateEnvelope(rawText, options = {}) {
  const { expectedNonce, binding, expectedExchangeId } = options;

  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('ENVELOPE_NOT_FOUND: Input text is empty or non-string');
  }

  // 1. 严格正则匹配 <RALLY_HANDOFF> 块
  const blockRegex = /<RALLY_HANDOFF>\s*([\s\S]*?)\s*<\/RALLY_HANDOFF>/g;
  const matches = [...rawText.matchAll(blockRegex)];

  if (matches.length === 0) {
    throw new Error('ENVELOPE_NOT_FOUND: No <RALLY_HANDOFF> block found in message');
  }
  if (matches.length > 1) {
    throw new Error('AMBIGUOUS_ENVELOPE: Multiple <RALLY_HANDOFF> blocks found in a single turn');
  }

  const rawJson = matches[0][1].trim();
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`ENVELOPE_PARSE_ERROR: Invalid JSON in handoff envelope: ${e.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VALIDATION_FAIL: Envelope root must be an object');
  }

  // 2. 版本校验
  if (parsed.version !== SUPPORTED_ENVELOPE_VERSION) {
    throw new Error(`VALIDATION_FAIL: Unsupported version ${parsed.version} (expected ${SUPPORTED_ENVELOPE_VERSION})`);
  }

  // 3. Nonce 校验 (Gate D 严格防御重放)
  if (!parsed.nonce || typeof parsed.nonce !== 'string') {
    throw new Error('VALIDATION_FAIL: Missing or invalid nonce in envelope');
  }
  if (expectedNonce && parsed.nonce !== expectedNonce) {
    throw new Error(`VALIDATION_FAIL: Nonce mismatch. Expected ${expectedNonce}, got ${parsed.nonce}`);
  }

  // 4. Target 校验
  if (parsed.target !== VALID_TARGET) {
    throw new Error(`VALIDATION_FAIL: Invalid target "${parsed.target}" (expected "${VALID_TARGET}")`);
  }

  // 5. Exchange ID 校验 (若指定)
  if (expectedExchangeId && parsed.exchange_id && parsed.exchange_id !== expectedExchangeId) {
    throw new Error(`VALIDATION_FAIL: Exchange ID mismatch. Expected ${expectedExchangeId}, got ${parsed.exchange_id}`);
  }

  // 6. Binding 校验 (若传入 binding)
  const allowedOps = binding?.capabilities || ALLOWED_OPERATIONS;
  if (binding) {
    if (parsed.binding_id && parsed.binding_id !== binding.binding_id) {
      throw new Error(`VALIDATION_FAIL: Binding ID mismatch. Expected ${binding.binding_id}, got ${parsed.binding_id}`);
    }
    if (parsed.binding_revision !== undefined && parsed.binding_revision !== binding.binding_revision) {
      throw new Error(`VALIDATION_FAIL: Stale binding revision. Expected ${binding.binding_revision}, got ${parsed.binding_revision}`);
    }
  }

  // 7. Operation 白名单校验 (严防未授权指令)
  if (!parsed.operation || typeof parsed.operation !== 'string') {
    throw new Error('VALIDATION_FAIL: Missing operation');
  }
  if (!allowedOps.includes(parsed.operation)) {
    throw new Error(`SECURITY_REJECT: Unsupported or unauthorized operation "${parsed.operation}"`);
  }

  // 8. Payload 结构校验 (针对 rally.echo)
  if (!parsed.payload || typeof parsed.payload !== 'object') {
    throw new Error('VALIDATION_FAIL: Missing or non-object payload');
  }
  if (parsed.operation === 'rally.echo') {
    if (typeof parsed.payload.text !== 'string' || !parsed.payload.text.trim()) {
      throw new Error('VALIDATION_FAIL: Operation "rally.echo" requires non-empty payload.text');
    }
  }

  return parsed;
}

/**
 * 格式化输出 Envelope 文本
 * @param {object} envelope
 * @returns {string}
 */
export function formatEnvelopeBlock(envelope) {
  return `<RALLY_HANDOFF>\n${JSON.stringify(envelope, null, 2)}\n</RALLY_HANDOFF>`;
}
