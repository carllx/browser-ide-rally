/**
 * Primary Generation 与辅助流前置分类器
 */
import { STREAM_CLASS } from './constants.js';

export class PrimaryClassifier {
  /**
   * 从 chunk 结构中精准提取 Assistant message_id
   * 严格要求 role === 'assistant'，坚决拒绝 user、system、tool 消息
   */
  static extractAssistantMessageId(chunk) {
    if (!chunk || typeof chunk !== 'object') return null;

    // 1. 标准 message 对象
    if (chunk.message && typeof chunk.message.id === 'string') {
      const author = chunk.message.author;
      if (author && author.role === 'assistant') {
        return chunk.message.id;
      }
      // 如果明确是其他角色，直接排除
      if (author && author.role && author.role !== 'assistant') {
        return null;
      }
    }

    // 2. 顶级 message_id 搭配明确的 role 或 metadata
    if (typeof chunk.message_id === 'string' && chunk.message_id.length > 20) {
      if (chunk.role === 'assistant' || chunk.message_role === 'assistant') {
        return chunk.message_id;
      }
      if (chunk.role && chunk.role !== 'assistant') return null;
    }

    // 3. Compact 差分 patch (如 p: "/message/id", v: "uuid")
    if (typeof chunk.p === 'string' && chunk.p.endsWith('/id') && typeof chunk.v === 'string' && chunk.v.length > 20) {
      // 只有当前上下文已被证实属于 assistant 时，或者路径明确指代 assistant 消息时
      if (chunk.p.includes('assistant') || !chunk.p.includes('user')) {
        return chunk.v;
      }
    }

    // 4. 递归检索嵌套（排除 user 输入区域）
    for (const key of Object.keys(chunk)) {
      if (key === 'input_message' || key === 'user') continue;
      if (typeof chunk[key] === 'object' && chunk[key] !== null) {
        const found = this.extractAssistantMessageId(chunk[key]);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * 检查是否包含有意义的生成文本/分词增量
   */
  static hasMeaningfulContentDelta(chunk) {
    if (!chunk || typeof chunk !== 'object') return false;
    // 典型的 delta 结构：包含 v 且属于文本追加或部分替换
    if ('v' in chunk) {
      const v = chunk.v;
      if (typeof v === 'string' && v.length > 0) return true;
      if (Array.isArray(v) && v.length > 0) return true;
      if (typeof v === 'object' && v !== null && (v.message || v.parts)) return true;
    }
    return false;
  }

  /**
   * 基于累积状态评估当前流类别
   */
  static evaluateStreamClass(streamState) {
    const {
      hasConversationId,
      assistantMessageId,
      meaningfulDeltaCount,
      totalChunksCount,
      hasDoneMarker
    } = streamState;

    // Primary Generation 准入标准：
    // 必须有 conversation_id，且拥有明确的 assistantMessageId 或多个有意义的内容差分分词
    if (hasConversationId && (assistantMessageId || meaningfulDeltaCount >= 2)) {
      return STREAM_CLASS.PRIMARY_GENERATION;
    }

    // 辅流特征：分词极少（通常 <= 2）、无 assistantMessageId、短时间内关闭
    if (totalChunksCount > 0 && !assistantMessageId && meaningfulDeltaCount === 0) {
      return STREAM_CLASS.AUXILIARY_STREAM;
    }

    return STREAM_CLASS.UNKNOWN;
  }
}
