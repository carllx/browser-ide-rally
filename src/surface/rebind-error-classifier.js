/**
 * IDE Rebind 错误确定性分类与中文行动指引模块 (Rebind Error Classifier)
 * 
 * 领域不变式与规范准则 (#40):
 * 1. 优先中文表达：主要错误说明与用户行动建议必须清晰、可操作且使用简体中文；
 * 2. 细节次要保留：有用的原始技术信息作为次要字段保留，辅助调试，严禁直接作为主提示；
 * 3. 涵盖全部分类：覆盖会话缺失、不可访问、已占用、元数据损坏、工作区缺失、Hook 失败、版本过期与 NEW/UNKNOWN 守卫；
 * 4. 纯函数设计：无副作用，便于独立单元测试与前端内嵌。
 */

/**
 * 将服务端/解析器返回的 Rebind 错误转化为面向操作者的结构化中文说明与操作指引
 * @param {string} rawReason 原始错误信息
 * @param {string} [stage='BLOCKED'] 动作阶段
 * @returns {{
 *   category: string,
 *   title: string,
 *   actionGuidance: string,
 *   highlightUnhandledCheckbox: boolean,
 *   highlightUnknownCheckbox: boolean,
 *   technicalDetail: string
 * }}
 */
export function classifyRebindError(rawReason = '', stage = 'BLOCKED') {
  const reason = String(rawReason || '').trim();

  // 1. 未处理 NEW 事实守卫阻断
  if (reason.includes('unhandled NEW result') || reason.includes('unhandled NEW')) {
    return {
      category: 'UNHANDLED_NEW',
      title: '目标端点存在未标记处理的 NEW 结果',
      actionGuidance: '安全守卫已默认阻断替换。若确认放弃并覆盖此未处理结果，请勾选下方的【强制替换未处理 NEW 事实】后重试。',
      highlightUnhandledCheckbox: true,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 2. 处于 UNKNOWN 状态守卫阻断
  if (reason.includes('UNKNOWN result') || reason.includes('UNKNOWN state') || (reason.includes('UNKNOWN') && reason.includes('confirmation'))) {
    return {
      category: 'UNHANDLED_UNKNOWN',
      title: '目标端点当前处于 UNKNOWN 状态',
      actionGuidance: '安全守卫已默认阻断替换。若确认要替换处于未知状态的端点，请勾选下方的【确认替换处于 UNKNOWN 的端点】后重试。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: true,
      technicalDetail: reason
    };
  }

  // 3. 会话 ID 缺失或为空
  if (reason.includes('conversation ID is required') || reason.includes('必须提供有效的会话 ID')) {
    return {
      category: 'MISSING_CONVERSATION_ID',
      title: '必须提供有效的 Antigravity 会话 ID',
      actionGuidance: '请在输入框中粘贴完整的 Antigravity Conversation UUID（例如从 Antigravity 界面或会话路径中复制）。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 4. 会话不存在或无法访问
  if (reason.includes('not found or inaccessible')) {
    return {
      category: 'CONVERSATION_INACCESSIBLE',
      title: '未找到指定的 Antigravity 会话或会话无法访问',
      actionGuidance: '请检查会话 ID 是否输入正确，并确保本地 Antigravity 正在运行且拥有该会话的访问权限。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 5. 跨项目已占用
  if (reason.includes('already bound to project')) {
    return {
      category: 'CONVERSATION_ALREADY_BOUND',
      title: '该 Antigravity 会话已被其他项目占用',
      actionGuidance: '为防止跨项目会话串线，同一会话不可在多个项目中重复绑定。请使用全新的会话 ID，或先在占用该会话的项目中解除绑定。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 6. 元数据解析异常
  if (reason.includes('Failed to parse Antigravity metadata')) {
    return {
      category: 'METADATA_PARSE_FAILED',
      title: 'Antigravity 会话元数据解析失败',
      actionGuidance: 'Antigravity 返回的数据不是有效的 JSON 格式。请确认本地 Antigravity 响应正常后重试。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 7. 无配置工作区或身份无法派生
  if (reason.includes('has no configured workspaces') || reason.includes('workspace or repository identity could not be derived')) {
    return {
      category: 'WORKSPACE_DERIVATION_FAILED',
      title: '该会话缺少有效的工作区或代码仓库配置',
      actionGuidance: 'Rally 无法从该会话中自动派生工作区路径与代码仓库标识。请确认该会话已关联有效且具备 Git 仓库的工作区。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 8. 工作区本地 Hook 安装失败
  if (reason.includes('WORKSPACE_HOOK_FAILED')) {
    return {
      category: 'HOOK_SETUP_FAILED',
      title: '工作区本地 Stop Hook 安装失败',
      actionGuidance: '无法在目标工作区写入或配置 .agents/hooks.json。请检查目录写权限，或确认该文件未被 Git 追踪。已有绑定未受影响。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 9. 绑定版本过期或失配
  if (reason.includes('STALE_OR_MISSING_BINDING_REVISION') || reason.includes('stale_or_missing_binding_revision') || reason.includes('revision mismatch')) {
    return {
      category: 'STALE_BINDING_REVISION',
      title: '项目绑定版本已过期 (并发变更)',
      actionGuidance: '当前界面的绑定版本已落后于服务端最新状态。正在自动刷新页面以同步最新版本，请稍候重试。',
      highlightUnhandledCheckbox: false,
      highlightUnknownCheckbox: false,
      technicalDetail: reason
    };
  }

  // 10. 通用后备
  return {
    category: 'GENERIC_BLOCKED',
    title: stage === 'FAILED' ? '端点重绑执行失败' : '端点重绑受阻',
    actionGuidance: '操作未通过安全校验。请根据下方的技术详情排查原因后重试。',
    highlightUnhandledCheckbox: false,
    highlightUnknownCheckbox: false,
    technicalDetail: reason
  };
}
