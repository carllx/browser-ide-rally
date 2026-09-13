# Bootstrap Handoff: Historical Evidence & Context

> **注意**：本文档属于 **历史启动证据（Historical Bootstrap Evidence）**，并非本项目的长期规范权威（Normative Authority）。后续的 `README.md`、GitHub Issues、规格说明书（Specs）、决策记录（ADRs）、经审查的代码以及实时任务追踪（Live Tracker）才是 Rally 的真实权威依据（Project Authority）。本文档将随工程推进逐渐降级为历史归档资料。

---

## 1. 产生背景与驱动动因 (Motivating Problems)

在双 Agent 协同（Browser Agent 与 IDE Agent）的真实工程实践中，频繁面临以下机械与认知负担：

1. **Repetitive Browser ↔ IDE Copy/Paste**：跨环境手工复制粘贴提示词、上下文和执行结果既繁琐又耗时。
2. **Clipboard Failures**：剪贴板截断、格式丢失或异步覆盖导致传递错误。
3. **Wrong Destination Conversation**：多窗口/多标签下，容易将内容误贴入非目标对话。
4. **Wrong Repository/Project**：容易将 A 项目的指示发给处于 B 项目工作区的 IDE 会话。
5. **Session Identity Confusion**：难以明确辨识哪一个本地 IDE 会话与哪一个浏览器会话绑定。
6. **Turn Ownership Ambiguity**：难以一眼判断当前轮次（Turn）由谁掌控（等待浏览器生成、等待人类确认、还是等待 IDE 执行）。

---

## 2. 已达成共识的核心决策 (Accepted)

1. **独立代码仓库**：确立独立工程仓库 `carllx/browser-ide-rally`。
2. **职责严格分离**：Rally 与 `matt-browser-workflow` 严格分离，Rally 仅负责中继通信与可见性，不重新定义流程语义。
3. **始终保持可回退性 (Optional & Fallback)**：Rally 是可选增强工具，手工回退（Manual relay）永远是可靠基线。
4. **1:1 会话拓扑**：第一阶段严格约束为 `1 Browser conversation ↔ 1 Antigravity conversation`，不搞复杂多路由编排。
5. **Antigravity 为首选 IDE 适配端**：基于 Google Antigravity 环境实现第一版适配。
6. **原型先于基础设施 (Prototype Before Infrastructure)**：先以最小技术栈验证可行性，严禁过度工程化。
7. **保留人类决策边界**：自动化中继不得绕过关键的人类决策关卡（Human Decision Boundary）。

---

## 3. 当前工作假设 (Working Hypotheses)

- **Tampermonkey 用户脚本**：作为成本最低、迭代最快的浏览器端探针与交互原型方案。
- **Localhost Companion**：作为第一候选的本地传输边界（Transport Boundary），桥接浏览器与本地环境。
- **Antigravity CLI**：作为第一候选的本地 IDE 接口。
- **Chrome Extension + Native Messaging**：仅作为后续原型证明具备明确价值且遇到底层能力限制时的潜在产品化升级路径，不提前采用。

---

## 4. 未决 / Phase 0 核心问题 (Unresolved / Phase 0 Questions)

### A. 浏览器轮次完成状态与回复捕获 (Browser Turn Completion & Response Capture)

**核心假设**：避免优先依赖 ChatGPT 页面不稳定且易变的 DOM/Layout 结构来判断 Agent 是否仍在生成回复。优先探索并通过实验验证：能否通过浏览器网络层（Network / Streaming Transport）获取更可靠的状态信号：

- Conversation identity
- Turn/message identity
- Response-start
- Streaming in-progress
- Completed
- Error/retry
- Final assistant content

**约束与验证要求**：
- **严禁直接假设 `network == stable authority`**。必须通过原型实验获取第一手证据（Evidence），验证：
  - ChatGPT 实际传输机制（Fetch, SSE, WebSocket 等）；
  - 流式传输完成的语义（Streaming completion semantics）；
  - Tool calls / Code interpreter 触发时的状态表现；
  - 遇到错误时的重试（Retry）、重新生成（Regenerate）以及分支会话（Branching）；
  - 页面断线重连（Reconnect）与刷新（Reload）；
  - ChatGPT 私有协议的变动与 drift 风险；
  - Tampermonkey 在当前沙箱机制下能否稳定捕获和劫持这些网络流。
- DOM 结构可作为潜在兜底（Fallback），但在获得充分运行时证据前，不预先固化层级来源策略（Source hierarchy）。

### B. 跨标签页会话注意力路由 (Cross-Tab Conversation Attention Routing)

**场景痛点**：开发者经常在后台同时打开多个 ChatGPT Projects、Conversations 或 Tabs。未来 Rally 需能实时掌握多会话全局状态，例如：

- `Conversation A` — Browser Working (正在生成)
- `Conversation B` — Completed / Ready for IDE (已完成，就绪待中继)
- `Conversation C` — Needs User Decision (等待用户确认/决策)
- `Conversation D` — Disconnected (连接断开)

**需要解决的关键问题**：
当后台未聚焦的标签页完成生成时，如何让开发者清晰无误地感知：
1. 涉及哪一个 Project；
2. 涉及哪一个 Conversation；
3. 对应哪一个具体的 Tab；
4. 当前处于什么状态；
5. 下一步应该切换并打开哪一个。

**候选提示机制**：包括但不限于 Tab Title 动态标记、Favicon/状态角标、浏览器/系统级通知（Notification）、轻量 Rally 状态面板、Local Companion 聚合状态等。

**明确依赖链条**：
```text
Reliable per-conversation state detection
  → cross-tab aggregation
    → attention routing / notification
```
必须遵循依赖关系，在可靠的单会话状态检测就绪前，严禁倒置设计通知 UI。
