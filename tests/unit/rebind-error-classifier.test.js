/**
 * Rebind 错误确定性分类器单元测试 (#40)
 * 验证已知失败类别全面映射为面向操作者的结构化中文说明与明确行动指导
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRebindError } from '../../src/surface/rebind-error-classifier.js';

describe('Rebind 错误确定性分类器单元测试 (#40)', () => {
  it('1. 未处理 NEW 事实：映射为清晰中文标题、显式指引并高亮 unhandled 复选框', () => {
    const raw = 'Cannot replace ide-primary endpoint with unhandled NEW result without explicit confirmation';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'UNHANDLED_NEW');
    assert.equal(res.title, '目标端点存在未标记处理的 NEW 结果');
    assert.match(res.actionGuidance, /强制替换未处理 NEW 事实/);
    assert.equal(res.highlightUnhandledCheckbox, true);
    assert.equal(res.highlightUnknownCheckbox, false);
    assert.equal(res.technicalDetail, raw);
  });

  it('2. UNKNOWN 状态：映射为清晰中文标题、显式指引并高亮 unknown 复选框', () => {
    const raw = 'Cannot replace ide-primary endpoint in UNKNOWN state without explicit confirmation';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'UNHANDLED_UNKNOWN');
    assert.equal(res.title, '目标端点当前处于 UNKNOWN 状态');
    assert.match(res.actionGuidance, /确认替换处于 UNKNOWN 的端点/);
    assert.equal(res.highlightUnhandledCheckbox, false);
    assert.equal(res.highlightUnknownCheckbox, true);
  });

  it('3. 会话缺失：映射为清晰中文指引', () => {
    const raw = 'Antigravity conversation ID is required.';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'MISSING_CONVERSATION_ID');
    assert.equal(res.title, '必须提供有效的 Antigravity 会话 ID');
    assert.match(res.actionGuidance, /完整.*UUID/);
  });

  it('4. 会话不存在或不可访问 (Review Blocker 1)：产出明确可操作的中文说明与排查行动', () => {
    const raw = 'Antigravity conversation "conv-ghost-999" not found or inaccessible. Please check the conversation ID and ensure Antigravity is running.';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'CONVERSATION_INACCESSIBLE');
    assert.equal(res.title, '未找到指定的 Antigravity 会话或会话无法访问');
    assert.match(res.actionGuidance, /确保本地 Antigravity 正在运行/);
    assert.match(res.actionGuidance, /检查会话 ID 是否输入正确/);
    assert.equal(res.technicalDetail, raw);
  });

  it('5. 跨项目已占用 (Review Blocker 2)：产出明确可操作的中文说明与排查行动', () => {
    const raw = 'Antigravity conversation "conv-taken" is already bound to project "Alpha Project".';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'CONVERSATION_ALREADY_BOUND');
    assert.equal(res.title, '该 Antigravity 会话已被其他项目占用');
    assert.match(res.actionGuidance, /防止跨项目会话串线/);
    assert.match(res.actionGuidance, /解除绑定/);
    assert.equal(res.technicalDetail, raw);
  });

  it('6. 元数据解析异常：映射为格式异常中文说明', () => {
    const raw = 'Failed to parse Antigravity metadata for conversation "conv-corrupt": Unexpected token <';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'METADATA_PARSE_FAILED');
    assert.equal(res.title, 'Antigravity 会话元数据解析失败');
    assert.match(res.actionGuidance, /JSON/);
  });

  it('7. 无配置工作区：映射为工作区缺失中文说明', () => {
    const raw = 'Antigravity conversation "conv-empty" has no configured workspaces.';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'WORKSPACE_DERIVATION_FAILED');
    assert.equal(res.title, '该会话缺少有效的工作区或代码仓库配置');
    assert.match(res.actionGuidance, /自动派生工作区路径与代码仓库/);
  });

  it('8. Hook 安装失败：映射为本地 Hook 安装失败中文说明', () => {
    const raw = 'WORKSPACE_HOOK_FAILED: EACCES: permission denied';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'HOOK_SETUP_FAILED');
    assert.equal(res.title, '工作区本地 Stop Hook 安装失败');
    assert.match(res.actionGuidance, /写权限.*Git 追踪/);
  });

  it('9. 绑定版本过期：映射为并发变更中文说明', () => {
    const raw = 'STALE_OR_MISSING_BINDING_REVISION: Expected revision 2, but canonical revision is 3';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'STALE_BINDING_REVISION');
    assert.equal(res.title, '项目绑定版本已过期 (并发变更)');
    assert.match(res.actionGuidance, /自动刷新页面以同步最新版本/);
  });

  it('10. 可执行文件缺失、权限不足与 Provider 响应异常分类', () => {
    // 可执行文件缺失
    const resEnoent = classifyRebindError('Antigravity agentapi executable not found at "/opt/agentapi"');
    assert.equal(resEnoent.category, 'EXECUTABLE_NOT_FOUND');
    assert.match(resEnoent.title, /未找到 Antigravity CLI 执行程序/);
    assert.match(resEnoent.actionGuidance, /AGENTAPI_BIN/);

    // 权限受阻
    const resPerm = classifyRebindError('Antigravity agentapi executable at "/opt/agentapi" permission denied.');
    assert.equal(resPerm.category, 'PERMISSION_DENIED');
    assert.match(resPerm.title, /执行程序权限不足/);
    assert.match(resPerm.actionGuidance, /chmod \+x/);

    // Provider 命令行异常（例如缺少 ANTIGRAVITY_LS_ADDRESS）
    const resProvider = classifyRebindError('Antigravity provider lookup failed: {"error": "ANTIGRAVITY_LS_ADDRESS is not set"}');
    assert.equal(resProvider.category, 'PROVIDER_COMMAND_FAILED');
    assert.match(resProvider.title, /Antigravity 宿主服务响应异常或未连接/);
    assert.match(resProvider.actionGuidance, /Antigravity 应用程序正在运行/);
  });

  it('11. 通用未知错误：提供安全兜底与技术详情展示', () => {
    const raw = 'Some totally unexpected upstream network glitch';
    const res = classifyRebindError(raw);
    assert.equal(res.category, 'GENERIC_BLOCKED');
    assert.equal(res.title, '端点重绑受阻');
    assert.match(res.actionGuidance, /排查原因后重试/);
    assert.equal(res.technicalDetail, raw);
  });
});
