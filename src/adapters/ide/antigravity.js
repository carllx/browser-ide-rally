/**
 * Antigravity IDE AgentAPI 适配器
 * 负责严格的目标工作区/仓库身份比对、受控指令派发与产物契约校验
 */

import fs from 'fs';
import { execFileSync } from 'child_process';

export const DEFAULT_AGENTAPI_BIN = '/Users/yamlam/.gemini/antigravity/bin/agentapi';

/**
 * 规范化 URI/路径用于严格精确匹配
 */
export function normalizeIdentityUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  return uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
}

/**
 * 默认 CLI 执行器
 */
export function defaultAgentApiExecutor(binPath, args) {
  return execFileSync(binPath, args, { encoding: 'utf8' }).trim();
}

export class AntigravityAdapter {
  constructor({
    binPath = DEFAULT_AGENTAPI_BIN,
    executor = defaultAgentApiExecutor
  } = {}) {
    this.binPath = binPath;
    this.executor = executor;
  }

  /**
   * 严格核验目标 IDE 会话的工作区与仓库身份
   * 严禁模糊 include，必须精确全等
   */
  verifyTargetIdentity(conversationId, expectedWorkspace, expectedRepo) {
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('IDENTITY_VERIFY_FAIL: conversationId must be a non-empty string');
    }

    const raw = this.executor(this.binPath, ['get-conversation-metadata', conversationId]);
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch (e) {
      throw new Error(`IDENTITY_VERIFY_FAIL: Failed to parse metadata output: ${e.message}`);
    }

    const workspaces = meta?.response?.conversationMetadata?.metadata?.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      throw new Error(`IDENTITY_VERIFY_FAIL: No workspaces configured for target conversation ${conversationId}`);
    }

    const ws = workspaces[0];
    const actualWsUri = ws.workspaceFolderAbsoluteUri || '';
    const actualRepo = ws.repository?.computedName || '';

    const normActual = normalizeIdentityUri(actualWsUri);
    const normExpected = normalizeIdentityUri(expectedWorkspace);

    if (normActual !== normExpected) {
      throw new Error(
        `IDENTITY_MISMATCH: Workspace URI mismatch for ${conversationId}. Expected exact "${normExpected}", got "${normActual}"`
      );
    }

    if (actualRepo !== expectedRepo) {
      throw new Error(
        `IDENTITY_MISMATCH: Repository identity mismatch for ${conversationId}. Expected exact "${expectedRepo}", got "${actualRepo}"`
      );
    }

    return {
      verified: true,
      conversationId,
      workspace: normActual,
      repository: actualRepo
    };
  }

  /**
   * 派发 rally.echo 任务至目标 IDE 会话
   * 产物路径完全由 Controller 拥有并传入，绝不接受浏览器端指定的路径
   */
  dispatchEchoTask({
    conversationId,
    envelope,
    artifactPath
  }) {
    if (!envelope || envelope.operation !== 'rally.echo') {
      throw new Error(`SECURITY_REJECT: Unsupported operation "${envelope?.operation}"`);
    }

    if (!artifactPath || typeof artifactPath !== 'string') {
      throw new Error('SECURITY_REJECT: Controlled artifactPath must be provided by Controller');
    }

    if (fs.existsSync(artifactPath)) {
      throw new Error(`DIRTY_STATE: Controlled artifact file already exists: ${artifactPath}`);
    }

    const instructionText = `This task was originated by Browser Agent via an explicit typed envelope.

Originating Envelope Nonce:
${envelope.nonce}

Operation:
${envelope.operation}

Payload Instruction:
${envelope.payload.text}

Execute the requested echo by creating exactly this file:
${artifactPath}

with exactly this JSON:
{
  "nonce": "${envelope.nonce}",
  "operation": "${envelope.operation}",
  "result": "RALLY_ECHO:${envelope.nonce}"
}

Do not modify the repository.
Do not create any other file.
After creating it, reply only:
RALLY_ECHO:${envelope.nonce}`;

    this.executor(this.binPath, [
      'send-message',
      `--title=Rally Ingress Task [${envelope.nonce}]`,
      conversationId,
      instructionText
    ]);

    return {
      dispatched: true,
      artifactPath,
      dispatchedAt: new Date().toISOString()
    };
  }

  /**
   * 轮询接收端产物并进行严格契约核验
   * 核验完成后立即清理临时产物
   */
  pollReceiverArtifact({
    artifactPath,
    expectedNonce,
    timeoutMs = 60000,
    pollIntervalMs = 1000
  }) {
    const tStart = Date.now();
    let resultData = null;
    let artifactStat = null;

    while (Date.now() - tStart < timeoutMs) {
      if (fs.existsSync(artifactPath)) {
        try {
          const stat = fs.statSync(artifactPath);
          const raw = fs.readFileSync(artifactPath, 'utf8');
          const parsed = JSON.parse(raw);

          if (parsed.nonce === expectedNonce && parsed.result === `RALLY_ECHO:${expectedNonce}`) {
            resultData = parsed;
            artifactStat = stat;
            break;
          }
        } catch (e) {
          // 产物可能正在写入，等待下一次轮询
        }
      }
      execFileSync('sleep', [(pollIntervalMs / 1000).toString()]);
    }

    if (!resultData) {
      throw new Error(`TIMEOUT: Receiver failed to produce valid artifact at "${artifactPath}" within ${timeoutMs}ms`);
    }

    // 成功读取后立即清理临时产物，确保不污染系统
    try {
      fs.unlinkSync(artifactPath);
    } catch (e) {}

    return {
      success: true,
      result: resultData,
      durationMs: Date.now() - tStart,
      stat: {
        size: artifactStat.size,
        mtime: artifactStat.mtime.toISOString()
      }
    };
  }
}
