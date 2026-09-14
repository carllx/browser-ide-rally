/**
 * 状态视图模块
 * 提供机器可读状态 Dump (JSON) 与紧凑纯文本状态视图 (Compact Status)
 */

/**
 * 生成机器可读状态 Dump
 */
export function formatStatusDump(binding, exchange) {
  return {
    timestamp: new Date().toISOString(),
    binding: binding ? {
      binding_id: binding.binding_id,
      binding_revision: binding.binding_revision,
      browser_provider: binding.browser?.provider || null,
      browser_conversation_id: binding.browser?.conversation_id || null,
      ide_conversation_id: binding.ide?.conversation_id || null,
      ide_workspace: binding.ide?.workspace_identity || null,
      ide_repository: binding.ide?.repository_identity || null,
      capabilities: binding.capabilities || [],
      paused: Boolean(binding.paused)
    } : null,
    exchange: exchange ? {
      exchange_id: exchange.exchange_id,
      nonce: exchange.nonce,
      phase: exchange.phase,
      binding_revision: exchange.binding_revision,
      blocker: exchange.blocker || null,
      needs_human: Boolean(exchange.needs_human),
      last_evidence: exchange.last_evidence || null,
      history_count: exchange.history?.length || 0,
      updated_at: exchange.updated_at
    } : null
  };
}

/**
 * 生成紧凑单行/多行文本状态
 * 示例：
 * Binding bind-001 rev=3 Browser connected / exact target IDE bound / workspace verified Exchange ex-104 Phase delivered_to_ide Paused false Human no Blocker none Evidence agentapi accepted @ ...
 */
export function formatCompactStatus(binding, exchange) {
  const bId = binding?.binding_id || 'none';
  const bRev = binding?.binding_revision ?? 0;
  const paused = binding?.paused ? 'true' : 'false';

  const exId = exchange?.exchange_id || 'none';
  const phase = exchange?.phase || 'none';
  const human = exchange?.needs_human ? 'yes' : 'no';
  const blocker = exchange?.blocker ? `"${exchange.blocker}"` : 'none';
  const evidence = exchange?.last_evidence ? (typeof exchange.last_evidence === 'string' ? exchange.last_evidence : JSON.stringify(exchange.last_evidence)) : 'none';

  return `Binding ${bId} rev=${bRev} Browser connected / exact target IDE bound / workspace verified Exchange ${exId} Phase ${phase} Paused ${paused} Human ${human} Blocker ${blocker} Evidence ${evidence}`;
}
