# Rally 返回路径与往返闭环 Spike 验证报告 (Gate B)

- **日期**: 2026-09-15 (Asia/Shanghai)
- **审查基线**: `6b26f64b7a23837fa7cb50d4ea117ede741bd8e9`
- **对应目标**: Gate B — Return-path-first + Round-trip-first Spike
- **最终状态**: **PASS** (首个完整的无人工搬运 Browser ↔ IDE 闭环验证成功)

---

## 1. 核心问题与成果总结

> 能否通过显式机制，将执行结果可靠返回到既有的 ChatGPT 浏览器会话，并促使该会话中的 Agent 自动继续推理，杜绝人工复制粘贴与错误目标分发？

### 核心结论：**PASS**
在当前真实运行环境中，成功完成了端到端闭环：
`Browser 会话 (WEB:028420c2...) → 本地 Controller 派发 → Antigravity 既有 GUI 会话 (8ce57ecd...) → 结果提取 → 原 Browser 会话自动回填提交 → 相同会话产生确定性 Nonce ACK`。
- **人工复制/粘贴**: **0 次**
- **错误目标分发**: **0 次**
- **重复执行**: **0 次**

---

## 2. Gate 1 — 浏览器返回路径实测 (Browser Return Path)

- **评级**: `VERIFIED CURRENT ENVIRONMENT`
- **执行机制**: 借助轻量级系统级自动化，精准定位 Chrome 当前绑定的活跃会话标签页，执行前置安全检查（核验 URL 会话 ID、检查是否存在未发送草稿、检查是否正在生成），使用标准编辑命令将结果文本安全填入，并触发提交按钮。
- **独立实测证据**:
  1. 准确识别并限定在目标会话：`https://chatgpt.com/c/WEB:028420c2-e56b-4914-a827-413bcac951db`；
  2. 注入唯一 Nonce: `RALLY_RETURN_9469396b-fff4-4b50-85a2-d90c46fb2076`；
  3. ChatGPT 真实落盘该轮对话并启动推理；
  4. 助手以纯文本精准回应：`ACK:RALLY_RETURN_9469396b-fff4-4b50-85a2-d90c46fb2076`；
  5. 往返耗时: 6.16 秒。

---

## 3. Gate 2 — 当前账号 Developer Mode / MCP 资格核验

- **评级**: `STILL AMBIGUOUS` (账号等级确定，但界面开发者开关受阻于人类权限门禁)
- **已证实环境事实 (VERIFIED CURRENT ENVIRONMENT)**:
  - 当前登录会话为 **Plus** 个人订阅账户 (`planType: "plus"`, `structure: "personal"`, 用户: `carllx@hotmail.com`)；
  - 账户内预装了 GPT-5.6 Sol、GPT-5.5、Deep Research 等模型支持。
- **未决与阻断边界 (BLOCKED BY HUMAN GATE / STILL AMBIGUOUS)**:
  - 官方文档对 Plus 订阅的 MCP 读写能力存在冲突说明（Developer Guide 称 Plus 支持，Help Center 称仅 Business/Enterprise 支持完整写操作）；
  - 设置弹窗中的 `Security and login` / `Plugins` 子面板未展示公开的开发者模式切换开关。进一步深入账号安全设置或修改账户权限涉及敏感账户隐私，属于必须的人类门禁。
- **处置原则**: 不继续推进 Tunnel/API Key 配置，不要求用户盲目升级套餐，暂时将自定义 MCP 标记为条件备选。

---

## 4. Gate 3 — 最小 Exchange 契约结构

本轮验证严格采用单一精简 Exchange 契约（文件持久化记录于 `/tmp/exchange_state.json`）：

```json
{
  "binding_id": "bind-mac-chatgpt-rally-001",
  "binding_revision": 1,
  "exchange_id": "exch-2521ce4e",
  "nonce": "RALLY_ECHO_6e54fdd0-2726-4de5-93d8-0554a1254369",
  "browser_conversation_id": "WEB:028420c2-e56b-4914-a827-413bcac951db",
  "ide_conversation_id": "8ce57ecd-a678-4e7b-b577-4c2be5987c87",
  "workspace": "file:///Users/yamlam/Documents/GitHub/browser-ide-rally",
  "repo_identity": "carllx/browser-ide-rally",
  "phase": "browser_acknowledged",
  "paused": false,
  "last_evidence": "Browser produced matching ACK with nonce: ACK:RALLY_ECHO_6e54fdd0-2726-4de5-93d8-0554a1254369",
  "blocker": null
}
```

*关键安全规则*：每个 Exchange 必须显式固化 `binding_revision`。若绑定版本升级，旧 Exchange 立即判定为 `stale / rejected`，绝不静默自动改道。

---

## 5. Gate 4 — 真实 Browser → IDE → Browser 往返实测

- **评级**: `VERIFIED CURRENT ENVIRONMENT (PASS)`
- **实测参数**:
  - Nonce: `RALLY_ECHO_6e54fdd0-2726-4de5-93d8-0554a1254369`
  - IDE 既有会话: `8ce57ecd-a678-4e7b-b577-4c2be5987c87`
  - Browser 既有会话: `WEB:028420c2-e56b-4914-a827-413bcac951db`
- **执行链路**:
  1. **Browser 意图构建**: 构造携带唯一 Nonce 的无副作用指令；
  2. **IDE 投递**: 通过 `/Users/yamlam/.gemini/antigravity/bin/agentapi send-message` 精确送达本地既有 GUI 会话；
  3. **结果计算与确认**: 提取并核验结果 `RALLY_ECHO:RALLY_ECHO_6e54fdd0-2726-4de5-93d8-0554a1254369`；
  4. **浏览器回传**: 自动注入并提交至原 ChatGPT 会话；
  5. **助手确认**: 原 ChatGPT 对话产出响应：
     `ACK:RALLY_ECHO_6e54fdd0-2726-4de5-93d8-0554a1254369`。
- **全链路往返耗时**: 10.39 秒。

---

## 6. Gate 5 — 关键安全反例与防御验证

在执行任何真实业务前，对核心安全边界进行了对抗性测试（自动化脚本 `/tmp/safety_counterexamples_test.js`）：

1. **绑定版本漂移 (Binding Revision Stale)**:
   - 构造基于 `revision: 1` 的请求，将全局绑定变更为 `revision: 2` 后投递。
   - **实测结果**: `status: "rejected"`, `reason: "STALE_REVISION"`。**PASS**（拒绝改道与旧消息串扰）。
2. **重复投递去重 (Duplicate Idempotency)**:
   - 连续两次投递相同 `exchange_id` 与 Nonce。
   - **实测结果**: 第一次 `accepted`，第二次被拦截为 `duplicate_ignored`。**PASS**（防止重复副作用）。
3. **不确定投递停止 (Unknown Delivery Safety)**:
   - 模拟发送后确认凭证丢失场景。
   - **实测结果**: 状态标记为 `unknown_delivery`，系统硬性**禁止盲目自动重试**。**PASS**（Fail closed）。
4. **浏览器草稿保护 (Browser Draft Guard)**:
   - 在输入框预置未提交草稿 `UNSAVED_USER_DRAFT_DO_NOT_OVERWRITE`。
   - **实测结果**: 前置检查抛出 `PREFLIGHT_FAIL: Target has unsent draft`，严格拒绝覆盖并回滚。**PASS**。
5. **全局暂停闩锁 (Pause Latch)**:
   - 设置 `paused: true` 后尝试发起投递。
   - **实测结果**: 立即被拒绝 `PAUSED: binding is paused`。**PASS**。

---

## 7. 架构路线定性与关键影响

本轮实机证据对各候选技术路线做出了决定性澄清：

1. **对 Tampermonkey**:
   - 彻底解除其“作为通用完成检测器”的沉重负担。R1–R6 缺陷不必在私有 SSE 解析器上死磕修复；
   - Tampermonkey 定位降级为：**可选的页面端定位与轻量状态可见性辅助工具**。
2. **对 ChatGPT 官方 MCP**:
   - 官方 Plus 权限口径冲突，且依赖复杂的组织平台配置；
   - 在证明通过轻量浏览器自动化能够做到 10 秒级可靠返回的前提下，**MCP 线路应当 DEFER（延后）**，不再作为阻塞主线的关键路径。
3. **对 Browser Automation / 轻量扩展**:
   - 实测证明：针对既有已登录会话，轻量页面控制能够安全实现前置草稿拦截、精准会话定位、文本注入与结果确认。
   - 架构首选聚焦于：**显式信封 (Explicit Envelope) + 本地轻量 Controller + 薄浏览器页面适配器**。

### 路线裁决更新：
维持 **B. Hybrid (混合架构)**，但明确其具体内涵：
- 意图与内容通过显式类型化信封交互；
- 浏览器侧由薄适配器（提供草稿保护、精确会话锚定与提交）支撑返回链路；
- IDE 侧由已验证的 `agentapi` 支撑现有会话直通。

---

## 8. 下一门禁 (Next Gate)

> **使用受限能力与严格沙箱，在已绑定的既有会话之间执行首个包含文件只读审计与确定性产物输出的真实工程任务。**
