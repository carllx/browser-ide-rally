/**
 * Typed Handoff Envelope 解析器与安全校验器
 * 
 * 领域不变式与安全准则 (#18):
 * 1. 强制版本钉住：必须携带并精确核验 binding_revision，缺失或陈旧一律 Fail-Closed；
 * 2. 强制精准端点目标：必须携带 exact target_endpoint (如 'ide-a')，严禁泛化 'bound_ide'；
 * 3. 严格白名单与类型传输：仅允许受控操作（如 rally.echo、rally.prompt、rally.inspect），
 *    严禁任何 Web 页面文本转化为未受控的本地 Shell 执行；
 * 4. 严格防御重放与歧义：单轮次多 Envelope 视为歧义拒绝。
 */

export const SUPPORTED_ENVELOPE_VERSION = 1;
export const ALLOWED_OPERATIONS = ['rally.echo', 'rally.prompt', 'rally.inspect'];
export const MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB bounded payload

/**
 * 提取并校验结构化 Envelope
 * @param {string} rawText - 包含 <RALLY_HANDOFF> 标签的消息文本
 * @param {object} options
 * @param {number} options.expectedBindingRevision - 期望的 Binding 规范版本（必填）
 * @param {string} [options.expectedNonce] - 期望的 fresh nonce
 * @param {string} [options.expectedBindingId] - 期望的 binding_id
 * @param {string} [options.expectedTargetEndpoint] - 期望的目标端点 ID
 * @param {Array<string>} [options.allowedOperations] - 允许的操作白名单
 * @returns {object} 校验合法的结构化 envelope
 */
export function extractAndValidateEnvelope(rawText, options = {}) {
  const {
    expectedBindingRevision,
    expectedNonce,
    expectedBindingId,
    expectedTargetEndpoint,
    allowedOperations = ALLOWED_OPERATIONS
  } = options;

  if (expectedBindingRevision === undefined || expectedBindingRevision === null || !Number.isInteger(expectedBindingRevision)) {
    throw new Error('VALIDATION_FAIL: expectedBindingRevision is required and must be an integer');
  }

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
    throw new Error('AMBIGUOUS_ENVELOPE: Multiple <RALLY_HANDOFF> blocks found in a single message');
  }

  const rawJson = matches[0][1].trim();
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`ENVELOPE_PARSE_ERROR: Invalid JSON in handoff envelope: ${e.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VALIDATION_FAIL: Envelope root must be a non-null object');
  }

  // 2. 版本校验
  if (parsed.version !== SUPPORTED_ENVELOPE_VERSION) {
    throw new Error(`VALIDATION_FAIL: Unsupported envelope version ${parsed.version} (expected ${SUPPORTED_ENVELOPE_VERSION})`);
  }

  // 3. Nonce 校验 (防御重放)
  if (!parsed.nonce || typeof parsed.nonce !== 'string' || !parsed.nonce.trim()) {
    throw new Error('VALIDATION_FAIL: Missing or invalid nonce in envelope');
  }
  if (expectedNonce && parsed.nonce !== expectedNonce) {
    throw new Error(`VALIDATION_FAIL: Nonce mismatch. Expected "${expectedNonce}", got "${parsed.nonce}"`);
  }

  // 4. 精准目标端点校验 (禁止 generic bound_ide)
  if (!parsed.target_endpoint || typeof parsed.target_endpoint !== 'string' || !parsed.target_endpoint.trim()) {
    throw new Error('VALIDATION_FAIL: Mandatory target_endpoint is required and must not be generic bound_ide');
  }
  if (parsed.target === 'bound_ide' || parsed.target_endpoint === 'bound_ide') {
    throw new Error('VALIDATION_FAIL: Mandatory target_endpoint is required and must not be generic bound_ide');
  }
  if (expectedTargetEndpoint && parsed.target_endpoint !== expectedTargetEndpoint) {
    throw new Error(`VALIDATION_FAIL: Target endpoint mismatch. Expected "${expectedTargetEndpoint}", got "${parsed.target_endpoint}"`);
  }

  // 5. Binding ID 校验 (强制非空，且若提供 expectedBindingId 则必须匹配)
  if (!parsed.binding_id || typeof parsed.binding_id !== 'string' || !parsed.binding_id.trim()) {
    throw new Error('VALIDATION_FAIL: Mandatory binding_id is required and must be a non-empty string');
  }
  if (expectedBindingId && parsed.binding_id !== expectedBindingId) {
    throw new Error(`VALIDATION_FAIL: Binding ID mismatch. Expected "${expectedBindingId}", got "${parsed.binding_id}"`);
  }

  // 6. Binding Revision 校验 (必须强校验，过期一律 fail-closed)
  if (parsed.binding_revision === undefined || parsed.binding_revision === null || parsed.binding_revision !== expectedBindingRevision) {
    throw new Error(
      `VALIDATION_FAIL: Stale or mismatched binding revision. Expected ${expectedBindingRevision}, got ${parsed.binding_revision}`
    );
  }

  // 7. Endpoint Revision 校验 (针对 IDE 端点世代边界，若提供 expectedEndpointRevision 且 parsed 携带则必须匹配)
  if (options.expectedEndpointRevision !== undefined && options.expectedEndpointRevision !== null) {
    if (parsed.endpoint_revision !== undefined && parsed.endpoint_revision !== null) {
      if (parsed.endpoint_revision !== options.expectedEndpointRevision) {
        throw new Error(
          `VALIDATION_FAIL: Stale or mismatched endpoint revision. Expected ${options.expectedEndpointRevision}, got ${parsed.endpoint_revision}`
        );
      }
    }
  }

  // 7. 操作白名单校验 (严禁 shell.exec 等未授权指令)
  if (!parsed.operation || typeof parsed.operation !== 'string') {
    throw new Error('VALIDATION_FAIL: Missing operation');
  }
  if (!allowedOperations.includes(parsed.operation)) {
    throw new Error(`SECURITY_REJECT: Unsupported or unauthorized operation "${parsed.operation}"`);
  }

  // 8. Payload 校验 (必须为有界对象)
  if (!parsed.payload || typeof parsed.payload !== 'object') {
    throw new Error('VALIDATION_FAIL: Missing or non-object payload');
  }

  const payloadByteLength = Buffer.byteLength(JSON.stringify(parsed.payload), 'utf8');
  if (payloadByteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`VALIDATION_FAIL: Payload size ${payloadByteLength} bytes exceeds bound of ${MAX_PAYLOAD_BYTES} bytes`);
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
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('VALIDATION_FAIL: envelope must be an object');
  }
  if (!envelope.binding_id || typeof envelope.binding_id !== 'string' || !envelope.binding_id.trim()) {
    throw new Error('VALIDATION_FAIL: binding_id is required and must be a non-empty string in envelope');
  }

  let normalizedPayload = envelope.payload;
  if (typeof normalizedPayload === 'string') {
    normalizedPayload = { text: normalizedPayload };
  } else if (!normalizedPayload || typeof normalizedPayload !== 'object') {
    normalizedPayload = { text: String(normalizedPayload || '') };
  }

  const payloadByteLength = Buffer.byteLength(JSON.stringify(normalizedPayload), 'utf8');
  if (payloadByteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`PAYLOAD_TOO_LARGE: Payload size ${payloadByteLength} bytes exceeds bound of ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const normalized = {
    ...envelope,
    payload: normalizedPayload
  };

  return `<RALLY_HANDOFF>\n${JSON.stringify(normalized, null, 2)}\n</RALLY_HANDOFF>`;
}
