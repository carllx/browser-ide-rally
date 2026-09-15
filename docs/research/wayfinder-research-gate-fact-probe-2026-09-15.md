# Wayfinder Research Gate 实机证据包 (Issue #9 & #11 Fact Probe — Bounded Pass)

- **日期**: 2026-09-15 (Asia/Shanghai)
- **环境**: macOS (Darwin 24.x), Google Chrome (ChatGPT Web), Google Antigravity GUI / agentapi
- **关联 Tickets**:
  - Issue #9: Research reliable Browser and IDE status signals independent of Relay
  - Issue #11: Verify stable turn identity and history reconciliation across Browser and IDE
  - 下游约束对准目标: Issue #8 (Binding & Turn Ledger)
- **判定状态**: **READY_FOR_BROWSER_REJOIN**

---

## 1. 核心结论矩阵

### 1.1 Issue #9 状态信号矩阵 (Browser & IDE Status Signals Independent of Relay)

| 验证项 | 候选信号 (Candidate) | 实机物理真值 (Ground Truth) | 判定结果 | 证据定性与边界约束 |
| :--- | :--- | :--- | :--- | :--- |
| **Browser 普通回答完成 (Normal Turn)** | 仅凭 DOM 暂时不变化 / 时间戳最新 | `button[data-testid="stop-button"]` (DOM text: `"Stop answering"`) 消失 + 文本静止 | **VERIFIED (PASS)** | **strong current-environment attributed completion evidence**。<br>纠偏：新版 ChatGPT DOM 已由 `Stop generating` 改为 `Stop answering`，必须使用 `button[data-testid="stop-button"]`。 |
| **Browser 思考/占位生命周期 (Thinking / Placeholder Turn)** | 出现新消息元素即判定完成 | 经历 `request-placeholder-...` 占位阶段，直至 `stop-button` 消失且 ID 转为真实 UUID | **VERIFIED (PASS)** | 思考开始时插入临时占位 ID（`request-placeholder-request-<id>`）；`stop-button` 严格经历 `false -> true -> false`（2次跳变），过滤 placeholder 后无 early terminal、duplicate、miss。 |
| **Browser 真实工具调用完成 (Real Tool-using Turn / Web Search)** | Prompt 包含工具请求即假定触发 | 触发真实 Web Search，DOM 生成搜索状态与 ECB 官方引用链接，`stop-button` 在整个网络工具调用与回答流式输出期间保持，结束后消失 | **VERIFIED (PASS)** | **strong current-environment attributed completion evidence**。<br>样本：ECB 汇率搜索真实抓取，最终 UUID `a8a2cddd...`，无 early terminal，同一会话精准归属。 |
| **Browser 双会话并发归属** | 依赖前台 activeTab | `locateExactConversationTab(convId)` 定位目标窗口/Tab 并双向核验 URL | **VERIFIED (PASS)** | 在实测 4 个打开的 ChatGPT Tab 之间，精确定位 Tab 3 (`6aa852d6`) 与 Tab 2 (`6aa88b24`)，Turn ID 互不干扰，归属明确。 |
| **Antigravity 普通 GUI 完成信号** | OS 系统通知 / DB 轮询 | Stop Lifecycle Hook 接收标准 JSON，包含 `fullyIdle: true` 与 `terminationReason: "NO_TOOL_CALL"` | **VERIFIED (PASS)** | 底层 Hook 由引擎直接触发，载荷完整包含会话与工作区身份。 |
| **Antigravity 多步工具调用中间事件** | 工具执行中可能存在假 Stop | 多步骤 Tool 执行全过程（规划 -> 调用工具 -> 产出最终回复），中间 Stop 事件计数为 **0** | **VERIFIED (PASS)** | 工具执行期间绝无中间假 Stop，仅在单轮工具链彻底结束且 `fullyIdle=true` 时单次触发。 |

---

### 1.2 Issue #11 轮次身份与历史对齐矩阵 (Turn Identity & History Reconciliation)

| 验证项 | 候选机制 | 实机物理真值 (Ground Truth) | 判定结果 | 证据定性与架构约束 |
| :--- | :--- | :--- | :--- | :--- |
| **Browser Turn Identity 跨刷新稳定性** | 临时 DOM 序号 / 文本哈希 | Assistant 消息 DOM 属性 `data-message-id` (原生 UUID) | **VERIFIED (PASS)** | **实机强制刷新 (Reload) 验证**：3 轮 Assistant Turn 在页面重新完全加载后，其 `data-message-id` 100% 全等保持（如 `0f71678c...`, `2f2b612b...`, `81245947...`），确认由服务端持久化下发。 |
| **Browser 新旧轮次区分与重启去重** | 内存数组比对 | 基于持久化 `last_processed_turn: <UUID>` 的断言守卫 | **VERIFIED (PASS)** | 模拟探针重启后，历史 Turn 均被识别并安全跳过；新触发的 Turn 被唯一识别并仅处理一次。 |
| **Antigravity Provider-native Turn ID** | Stop Hook 是否自带原生 turnId UUID | Stop Hook 提供 `conversationId`, `executionNum`, `fullyIdle`, `terminationReason`，**未提供 native turn UUID** | **UNRESOLVED (AS NATIVE UUID)**<br>`->` 见下行 Fallback | 确认 Antigravity 官方 Hook 规范目前不直接暴露单个全局 `turnId`。 |
| **Antigravity 游标 Fallback 可行性** | `opaque adapter/provider turn cursor` | 当前版本适配器实现：Transcript（`transcript.jsonl`）单调递增 `step_index` + 可选 contentHash 作为本地游标 | **VERIFIED CURRENT ENVIRONMENT / adapter candidate validated** | **bounded current-environment replay-safety probe PASS**。<br>重启探针后未处理轮次为 0；新指令推进后捕获唯一新轮次；再次重启仍为 0。 |

---

## 2. 实际执行的实机探针证据 (Executed Probes & Logs)

### 2.1 探针 A: Browser 页面刷新后 Turn Identity 稳定性测试
- **目标会话**: `https://chatgpt.com/c/6aa852d6-f6f0-83e8-aa9d-cc55983cb81b` (Window 1, Tab 3)
- **实测数据**: 刷新前记录 3 轮已完成 Assistant Turn（`0f71678c...`, `2f2b612b...`, `81245947...`）。执行 AppleScript reload 并在页面加载完成后重新抓取，3 轮 ID 与内容严格一一对应，`data-message-id` 完全一致。

### 2.2 探针 B: Browser 思考型/占位符生命周期采样
- **采样频率**: 250ms 高频采样，连续采样 26 次。
- **状态流转**: 明确观察到初期 `request-placeholder-...` 临时 ID，随后 `button[data-testid="stop-button"]` 严格经历 `false -> true -> false`（2 次跳变），收敛为最终真实 UUID（`1f7801c7-fcc7-41a4-910c-3b342279568a`），无 early terminal。

### 2.3 探针 C: Browser 真实工具调用轮次实测 (Real Tool-using Turn / Web Search)
- **触发 Prompt**: `Search the web: What is the current USD to EUR exchange rate today (September 2026)? Show source.`
- **可观察真实工具证据**:
  - DOM 中渲染了真实的 Citation 与搜索来源：`European Central Bank`
  - 外部引用真实 URL: `https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.et.html?utm_source=chatgpt.com`
  - 提取数据：`1 USD = 0.8667 EUR`
  - 生命周期：`hasStopBtn` 在 Web Search 请求、数据拉取及流式生成全程保持为 `true`，耗时 17.6s，结束后转为 `false`；
  - 最终 Turn ID: `a8a2cddd-4021-488b-97b7-dbd672ea4f6e`（非 placeholder）；
  - 归属核验：精确归属于会话 `6aa852d6`，无 early terminal，无 duplicate，无 miss。

### 2.4 探针 D: Antigravity Stop Hook 载荷与多步工具无假 Stop 验证
- **测试场景**: 向独立会话派发多步骤任务（触发安全检查与子智能体查询工具链）。
- **实测表现**: 在多步工具执行期间，Stop Hook 触发次数为 **0**；仅在全部工具调用完结、最终 `PLANNER_RESPONSE` 达到 `DONE` 且 `fullyIdle=true` 时唯一触发 1 次。
- **载荷真实样本**:
  ```json
  {
    "artifactDirectoryPath": "/Users/yamlam/.gemini/antigravity/brain/aff8b01a-766a-4f33-a4ee-70aa66e2ff17",
    "conversationId": "aff8b01a-766a-4f33-a4ee-70aa66e2ff17",
    "error": "",
    "executionNum": 0,
    "fullyIdle": true,
    "modelName": "gemini-3.8-flash-tiered",
    "terminationReason": "NO_TOOL_CALL",
    "transcriptPath": "/Users/yamlam/.../logs/transcript_full.jsonl",
    "workspacePaths": ["/Users/yamlam/Documents/GitHub/browser-ide-rally"]
  }
  ```

### 2.5 探针 E: Antigravity 本地游标适配器候选实测 (Adapter Candidate Validated)
- **实测表现**:
  - 基线保存游标 `terminalStep=5`；
  - 模拟重启：扫描 Transcript，未处理轮次为 0；
  - 派发新消息：产生新轮次推进至 `terminalStep=7`，准确识别出 1 个新轮次；
  - 再次重启：未处理轮次为 0；
  - 结论：**bounded current-environment replay-safety probe PASS**。

---

## 3. 对 Issue #8 (Binding & Turn Ledger) 的架构契约收窄

根据 Join Review 意见，将 #8 的核心契约规范收窄如下：

1. **统一建模为不透明游标 (Opaque Adapter/Provider Turn Cursor)**:
   - Rally Core Ledger **不应**硬编码提供商特有的内部结构（如直接将 `{ conversationId, terminalStepIndex, contentHash }` 作为 Core Schema）。
   - Rally Core 只存储并比对 `opaque turn cursor`，核心关注游标的单调性与推进。
2. **适配器本地实现细节 (Adapter-Local Implementation Details)**:
   - **Browser Adapter 候选实现**: 目前使用 ChatGPT 原生 `data-message-id` 作为游标，并由适配器负责过滤 `request-placeholder-*` 临时节点，在 `stop-button` 消失后输出。
   - **Antigravity Adapter 候选实现**: 在当前已安装版本中，适配器可利用 Transcript 的 `step_index` (+ 可选 contentHash) 派生本地单调游标。这属于适配器私有实现，非永久核心协议。
3. **完成态证据定性**:
   - 浏览器端 DOM 完成信号定性为 **strong current-environment attributed completion evidence**，而非权威长期协议。适配器需对外产出可靠的归属完成事件，无法确定时坚决 `fail-closed`。
4. **历史中断恢复准则 (Recovery Fallback)**:
   - 当遇到重启后历史不连续、会话漂移或游标无法对齐时，统一执行：
     **`FAIL_CLOSED: UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION`**，绝不进行猜测式推进或回放。

---

## 4. 全局配置清理与安全性声明 (Safety Cleanup Check)

- **临时 Hook 清理**: 本地探针临时使用的 `.agents/hooks.json` 与 `~/.gemini/config/hooks.json` 均已完全删除并确认不存在。
- **前置状态确认**: 由于缺乏系统级前置快照，规范记录为 **`pre-existing global hook state unknown`**；当前全局与工作区环境已确认无残留 Rally Hook 注入。

---

## 5. 结论

- **阻塞性风险 (Blockers)**: **NONE**
- **最终裁决**: **READY_FOR_BROWSER_REJOIN**
