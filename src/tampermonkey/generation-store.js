/**
 * 身份模型与活跃代际状态仓储
 */
import { CONFIDENCE } from './constants.js';

export class GenerationSession {
  constructor(localGenId, conversationId = null) {
    this.localGenId = localGenId;
    this.conversationId = conversationId;
    this.messageId = null;
    this.streamClass = null;

    // 网络层状态
    this.networkStarted = false;
    this.networkDone = false;
    this.networkDoneTimeMs = null;

    // DOM 层状态
    this.stopSeenForGeneration = false;
    this.domUiCompleted = false;
    this.domStopTimeMs = null;

    // 用户操作
    this.userStopActionSeen = false;

    // 仲裁与证据状态
    this.startedEmitted = false;
    this.terminalEmitted = false;
    this.terminalEventType = null;
    this.evidenceConfidence = null;
    this.graceTimer = null;
  }

  bindConversationId(cid) {
    if (cid && (!this.conversationId || this.conversationId === 'new_chat_pending')) {
      this.conversationId = cid;
    }
  }

  bindAssistantMessageId(mid) {
    if (mid && !this.messageId) {
      this.messageId = mid;
    }
  }

  markTerminalEmitted(eventType, confidence) {
    this.terminalEmitted = true;
    this.terminalEventType = eventType;
    this.evidenceConfidence = confidence;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /**
   * 晚到 DOM 证据安全升级：只修改内部 evidence，严禁重复发射公开事件
   */
  upgradeEvidenceToConfirmed() {
    if (this.terminalEmitted && this.evidenceConfidence === CONFIDENCE.NETWORK_ONLY) {
      this.evidenceConfidence = CONFIDENCE.CONFIRMED;
      return true;
    }
    return false;
  }
}

export class GenerationStore {
  constructor() {
    this.activeSession = null;
    this.history = [];
  }

  createSession(conversationId = null) {
    const localId = 'gen_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const session = new GenerationSession(localId, conversationId);
    this.activeSession = session;
    this.history.push(session);
    return session;
  }

  getActiveSession() {
    return this.activeSession;
  }

  clearActiveSession(session) {
    if (this.activeSession === session) {
      this.activeSession = null;
    }
  }

  getAllSessions() {
    return [...this.history];
  }

  reset() {
    if (this.activeSession && this.activeSession.graceTimer) {
      clearTimeout(this.activeSession.graceTimer);
    }
    this.activeSession = null;
    this.history.length = 0;
  }
}
