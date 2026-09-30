/**
 * ChatGPT 会话链接解析与身份归一化单一共享权威模块 (#39)
 * 
 * 领域不变式与规范准则:
 * 1. 单一解析权威：Onboarding 引导与 Browser Rebind 共享同一套 ChatGPT 链接解析规则与正则，严禁重复定义；
 * 2. 完整 URL 支持：支持 https://chatgpt.com/c/<id>、https://chat.openai.com/c/<id>、https://chatgpt.com/g/<gpt>/c/<id> 以及合法 Query/Hash/尾部斜杠；
 * 3. 裸 ID (Bare Exact ID) 兼容性：仅当输入符合规范会话 Token 语法且不具备 URL/路径特征时，允许作为自身归一化；
 * 4. 严格 Fail-Closed：非 ChatGPT 域名、相对路径、缺少 ID 的 URL 严禁 Fall-Through 逃逸为裸 ID；
 * 5. 用户友好错误：向操作者提供清晰的人话错误指引，诊断/正则细节保留在内部。
 */

/**
 * 匹配合法 ChatGPT 会话 URL 的共享正则表达式
 */
export const CHATGPT_URL_PATTERN = /^https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:g\/[^\/]+\/)?c\/([a-zA-Z0-9_-]+)(?:[?#\/]|$)/i;

/**
 * 匹配合法 ChatGPT 会话 ID Token 语法的共享正则表达式
 */
export const CHATGPT_TOKEN_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 严格解析 ChatGPT 会话完整 URL (与 Onboarding 既有契约完全一致)
 * 仅接受完整 URL，若传入裸 ID 或非标准 URL 则抛出错误。
 * 
 * @param {string} url
 * @returns {string} 提取出的规范 conversationId
 */
export function parseChatGPTConversationUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error('Invalid ChatGPT conversation URL. Please provide a full URL such as https://chatgpt.com/c/<conversation-id>');
  }

  const cleaned = url.trim();
  const match = cleaned.match(CHATGPT_URL_PATTERN);

  if (!match || !match[1]) {
    throw new Error('Invalid ChatGPT conversation URL. Please provide a full URL such as https://chatgpt.com/c/<conversation-id>');
  }

  return match[1];
}

/**
 * 归一化 ChatGPT 会话输入 (用于 Browser Rebind 及通用受信任输入端点)
 * 支持完整 URL 或合法的裸 ID，严格杜绝非 ChatGPT URL 逃逸。
 * 
 * @param {string} input 完整 ChatGPT URL 或纯会话 ID
 * @returns {string} 提取出的精确规范 conversationId
 */
export function normalizeChatGPTConversationInput(input) {
  if (!input || typeof input !== 'string' || !input.trim()) {
    throw new Error('INVALID_CHATGPT_CONVERSATION: 请提供有效的 ChatGPT 对话网址（例如 https://chatgpt.com/c/<id>）或对话 ID。');
  }

  const cleaned = input.trim();

  // 1. 尝试匹配标准 ChatGPT 会话 URL
  const urlMatch = cleaned.match(CHATGPT_URL_PATTERN);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  // 2. 检测是否具备 URL 或路径特征（协议、域名、路径斜杠、参数等）
  // 具备此类特征但未命中 CHATGPT_URL_PATTERN 者，属于非标准/非 ChatGPT URL，必须 Fail-Closed，绝不 Fall-Through 为裸 ID
  const looksLikeUrlOrPath = /^(?:https?:\/\/|[a-z0-9_.-]+\.[a-z]{2,}|\/|[?#]|.*[/?#\\])/i.test(cleaned);
  if (looksLikeUrlOrPath) {
    throw new Error('INVALID_CHATGPT_CONVERSATION: 无法识别的 ChatGPT 对话链接。请提供完整的 ChatGPT 网址（如 https://chatgpt.com/c/<id>）或有效的对话 ID。');
  }

  // 3. 校验合法的裸 ID (Bare Exact Token)
  if (CHATGPT_TOKEN_PATTERN.test(cleaned)) {
    return cleaned;
  }

  // 4. 其余不合规字符形式一律拒绝
  throw new Error('INVALID_CHATGPT_CONVERSATION: 对话 ID 格式不合规。请检查是否包含非法特殊字符。');
}
