# Phase 1 研究报告：跨端点结果身份、时间戳与时序裁决机制

> **研究任务标识**：GitHub Issue #35 (Phase 1 Result Identity & Timestamp Ordering)  
> **关联规范与映射**：#33 (Spec), #15 (ChatGPT Browser Seam), #16 (Antigravity IDE Seam), #27 (Observation Runtime)  
> **交付物定位**：`docs/research/phase1-result-identity-timestamp-ordering.md`  
> **研究时间**：2026-09-20  
> **执行环境**：macOS (Darwin arm64), Google Chrome (AppleScript JS 注入), Antigravity Runtime/Filesystem (`~/.gemini/antigravity`)

---

## 1. 核心分类结论 (Required Classifications)

依据本报告在真实 ChatGPT 浏览器环境与 Antigravity 本地运行时/文件系统获得的现场实证，给出三项核心裁决：

| 分类维度 | 裁决结果 | 核心判据概述 |
|---|---|---|
| **Antigravity 来源策略** | **`HYBRID_PRIMARY`** | 单独依赖运行时 Stop Hook 无法满足进程重启/休眠后的离线恢复（错过瞬态事件）；单独依赖 `transcript.jsonl` 在并发生成时缺乏终结性凭据，且可能因中间思考步骤产生虚假完成。必须以**运行时 Stop Hook 作为终结性证据 (Finality Evidence)**，以**已落盘 transcript.jsonl 作为持久化顺序与重建真值 (Persisted Ordering & Reconstruction Truth)**。 |
| **跨端点最新结果排序** | **`PROVIDER_LOCAL_ORDER_ONLY`** | 两个端点各自在其内部均具备严格且单调的偏序（Browser 依 DOM 树文档序与 UUIDv4，IDE 依单调 `step_index`）；但跨端点时间戳语义严重不对称（Browser 缺乏原生时间戳，仅有 Rally 观察时间；IDE `step.created_at` 仅为步骤创建时间而非推理完成时间，且精度仅到秒）。**严禁跨端点直接进行时间戳比对 (`DIRECT_TIMESTAMP_ORDERING`)**。全局“最新结果”必须由 Rally 协调中心依据受信观察事件时序维护。 |
| **Browser 端点最小充分性** | **`BROWSER_MINIMUM_SUFFICIENT`** | 现有基于 `#15` 的 DOM 探针缝隙（原子核验 URL + 排除 `stop-button` 生成中 + 过滤占位 ID + 提取最终 `data-message-id`）对于 Phase 1 所需的**结果身份唯一定位、完成状态判定与页面重载持久性已完全充分**。实证表明无需亦严禁擅自引入重型的全量 Message Ledger。 |

---

## 2. 证据分级规范 (Evidence Taxonomy)

本文档严格区分以下三类证据属性：
- **[Verified - 已验证]**：在当前真实生产环境（Chrome 活跃标签页、Antigravity 真实 transcript/hook 交互）或现有自动化测试中实际执行并复现的第一手客观证据。
- **[Reported - 已报告]**：来自产品架构规范、官方接口文档、已关闭 Issue 契约（#15, #16, #27, #33）明确声明并记录的行为。
- **[Inferred - 已推断]**：基于底层工程原理、分布式系统时钟约束及实测现象逻辑推导出的技术结论。

---

## 3. 真实探针与受检上下文 (Executed Probes & Targets)

本研究针对本地真实活跃环境执行了无副作用的只读探测：

1. **ChatGPT 真实会话探测**：
   - **目标会话**：`6aaf3983-844c-83e9-bcdb-5fcb59afd442`（URL: `https://chatgpt.com/g/g-p-6aa6259857808191af5554e99e447495-browser-ide-rally/c/6aaf3983-844c-83e9-bcdb-5fcb59afd442`）。
   - **探测方法**：利用 `ChatGPTBrowserAdapter` 封装的非抢焦 AppleScript 执行 DOM 深度属性遍历探针与客户端状态检测。
   - **检查项**：DOM `data-message-*` 属性、`<time>` 标签、文本时间戳、React Fiber 挂载节点、`window.__NEXT_DATA__`、全局状态变量。
2. **Antigravity 真实会话与文件系统探测**：
   - **当前活跃会话**：`0212808d-3d2f-43e2-80ad-dcd4c247287b`。
   - **多轮历史样本会话**：`0010e3c5-0bb8-47ec-ae51-8ebcef46f5d4`、`00ed06b9-bfa5-43e7-8c42-bf354dfb3aec`（提取自本地 `~/.gemini/antigravity/brain/` 下 579 个真实对话目录）。
   - **探测方法**：对 `transcript.jsonl` 执行逐行序列分析、时间戳递进分析、并发半行尾部 (Partial Tail) 截断解析压力测试、文件系统 Inode 与大小增长追踪。

---

## 4. ChatGPT 浏览器证据表 (Browser Evidence Table)

| 探测字段 / 特性 | 是否可用 | 稳定身份/顺序? | 语义类别 | 提供方来源? | 重启/刷新可查? | Phase 1 判定与证据说明 |
|---|---|---|---|---|---|---|
| `data-message-id` | **可用** [Verified] | **是**（唯一 UUID）[Verified] | Result Identity (消息唯一身份) | **是**（服务端分配）[Verified] | **是** [Verified] | **SAFE**：在 DOM 中稳定存在（如 `13395b0b-...`），刷新后保持不变；严格过滤 `placeholder-*` 与 `request-placeholder-*` 后作为 `chatgpt_msg_<id>` 游标。 |
| `<time>` 元素 | **不可用** (数量: 0) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：DOM 树中不存在 `<time>` 标签。 |
| `data-message-time` 等时间属性 | **不可用** (匹配数: 0) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：遍历所有属性及子元素，无任何包含 `time/date/created/updated/timestamp` 的 DOM 属性。 |
| `window.__NEXT_DATA__` | **不可用** (`false`) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：客户端运行时未暴露该全局对象。 |
| React Fiber Internal Props | **不可用** (`hasFiberKey: false`) [Verified] | 否 | 内部实现私有状态 | 否 | 否 | **UNSAFE**：DOM 元素未暴露可访问的 Fiber 状态，侵入抓取脆弱且不可靠。 |
| `button[data-testid="stop-button"]` | **可用** [Verified] | **是**（生成中瞬态）[Verified] | Generation In-Progress Indicator | **是**（前端状态）[Verified] | **是** [Verified] | **SAFE**：严格用于区分正在生成与完成状态，生成中不更新结果事实。 |
| DOM 树节点位置顺序 | **可用** [Verified] | **是**（局部单调序列）[Verified] | Provider-Local Document Order | **是**（页面渲染序）[Verified] | **是** [Verified] | **SAFE**：同一会话内 Assistant 消息的物理索引（第 0, 1, 2 条）在 DOM 内绝对单调有序。 |
| Rally Adapter `completed_at` | **可用** [Verified] | 仅为观察序，非原生序 [Inferred] | Rally Observation Time (本地观测时刻) | **否**（Rally 本地时钟）[Verified] | 否（重启会变）[Inferred] | **CONDITIONAL**：仅能作为本地观测登记时间，绝对不能作为跨端点权威完成时间进行数学比较。 |

---

## 5. Antigravity 运行时证据表 (Antigravity Runtime / Stop Hook)

| 探测字段 / 特性 | 是否可用 | 稳定身份/顺序? | 语义类别 | 提供方来源? | 重启/刷新可查? | Phase 1 判定与证据说明 |
|---|---|---|---|---|---|---|
| Stop Hook 进程触发 | **可用** [Verified] | 瞬态事件 [Verified] | Finality Evidence (任务终止终结性) | **是**（IDE 官方触发）[Verified] | **否**（瞬态 IPC）[Verified] | **SAFE (用于实时终结触发)**：在任务 `fullyIdle=true` 且无后续工具调用时触发，是证明 Agent 不再产生动作的最佳收敛信号。 |
| `hookPayload.fullyIdle` | **可用** [Verified] | 布尔状态 [Verified] | Agent 状态收敛标志 | **是**（IDE 内部状态）[Verified] | 否 | **SAFE**：严格要求 `true`，防止在中间暂停或工具执行间隙提前提交。 |
| `hookPayload.terminationReason` | **可用** [Verified] | 枚举 [Verified] | 终止原因分类 | **是**（IDE 内部状态）[Verified] | 否 | **SAFE**：严格限制必须为 `NO_TOOL_CALL`，排除异常中断或中间阶段。 |
| `hookPayload.conversationId` | **可用** [Verified] | 会话身份 [Verified] | Exact Conversation Attribution | **是** | 否 | **SAFE**：严格比对绑定会话，不匹配直接短路拒绝。 |
| Hook 触发时间戳 | **未显式提供** [Verified] | 否 | 接收时刻由 Bridge / Rally 记录 | 否 | 否 | **UNSAFE**：Hook 载荷自身不含服务端时间戳，若 Rally 延迟接收会产生漂移。 |

---

## 6. Antigravity 持久化文件证据表 (transcript.jsonl)

对真实日志 `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` 进行实测：

| 探测字段 / 特性 | 是否可用 | 稳定身份/顺序? | 语义类别 | 提供方来源? | 重启/刷新可查? | Phase 1 判定与证据说明 |
|---|---|---|---|---|---|---|
| `step.step_index` | **可用** [Verified] | **是**（严格自增整型）[Verified] | Monotonic Sequence Identity | **是**（IDE 核心逻辑）[Verified] | **是** [Verified] | **SAFE**：单调递增整数（0, 1, 2, ...），构成端点内部完美严格全序。 |
| Content Fingerprint | **可用** [Verified] | **是**（SHA-256 前 16 位）[Verified] | Content Tamper & Drift Detection | **是**（派生自内容）[Verified] | **Yes** [Verified] | **SAFE**：与 `step_index` 组合构成不透明游标 `ag-step:<idx>:<hash>`，防御历史截断或漂移。 |
| `step.created_at` | **可用** [Verified] | 弱单调（存在同秒）[Verified] | **Step Creation Time** (步骤创建时间) | **是**（IDE 后端系统时钟）[Verified] | **是** [Verified] | **CONDITIONAL**：格式为 UTC ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`)，秒级精度。实测证实：其为步骤**创建时刻**，与紧邻的 `USER_INPUT` 经常完全同秒，**绝非模型推理完成时刻**！不可用于跨端点精准比对。 |
| `step.type === 'PLANNER_RESPONSE'` & `status === 'DONE'` & `tool_calls.length === 0` | **可用** [Verified] | **是**（完成轮次模式）[Verified] | Completed Result Identification | **是** | **是** [Verified] | **SAFE**：准确从众多中间工具调用中过滤出最终呈现给用户的响应。 |
| 写入方式 (Append vs Replace) | **追加写入** [Verified] | Inode 保持不变，文件持续累加 [Verified] | Append-Only Stream | **是** | **是** [Verified] | **SAFE**：实测 Inode 固定为 369447098，文件大小随调用递增，不存在写临时文件原子覆盖引起的读竞争丢失。 |
| 并发读取半行尾部 (Partial Tail) | **可被安全隔离** [Verified] | 格式校验守卫 [Verified] | Fault-Tolerant Parse | **是**（适配器防卫能力）[Verified] | **是** [Verified] | **SAFE**：实测解析器通过 `try...catch(JSON.parse)` 忽略截断尾行，不会崩溃，亦不会发明虚假完成。 |
| 文件系统 `mtime` | **可用但不稳定** [Verified] | 易受污染 [Verified] | OS File Modified Time | 否（受 OS / 外部工具影响） | 否 | **STRICTLY UNSAFE**：整个会话仅单个日志文件，`mtime` 仅反映最后一次写入；任何工具、Spotlight 索引或 touch 都会改动它，严禁作为结果真值。 |

---

## 7. 运行时 vs 文件 vs 混合模式权衡矩阵 (Tradeoff Matrix)

| 评估维度 | 方案 A: RUNTIME_PRIMARY (纯 Hook 驱动) | 方案 B: FILE_PRIMARY (纯文件轮询) | 方案 C: HYBRID_PRIMARY (混合模式，推荐) |
|---|---|---|---|
| **实时性 (Latency)** | 极高（进程触发即时到达） | 受轮询间隔限制（存在秒级延迟） | **极高**（实时事件优先触发） |
| **终结性判定 (Finality)** | 极强（`fullyIdle: true` 保证无后续调用） | 弱（文件尾部可能只是中间停顿步骤） | **极强**（以 Hook 的 `fullyIdle` 确保终结） |
| **重启与离线重构 (Durability)** | **致命缺失**（Rally 未运行时事件永远丢失） | 强（全量历史可随时回放重构） | **极强**（未运行时通过文件日志重构历史） |
| **资源与 IO 开销** | 零轮询开销 | 频繁读取大文件消耗 IO/CPU | **极低**（平时仅事件触发，仅启动时读取一次） |
| **并发写冲突防御** | 无冲突（仅接收通知） | 容易读到写了一半的半行 JSON | **安全**（Hook 触发时写操作已完成，容错解析器兜底） |
| **综合裁决** | ❌ 无法满足离线可恢复性 | ❌ 缺乏终结性凭据，易被中间态误导 |  **唯一满足 Phase 1 全部契约的策略** |

---

## 8. 跨端点时间戳与排序对比 (Cross-Provider Comparison)

针对 Issue #35 要求的跨端点比较项，给出实证分析：

### 8.1 语义不对称性 (Semantic Asymmetry)
- **Antigravity**：`step.created_at` 记录的是**步骤创建/初始化时间 (Creation Time)**。
  - 实测证据：在会话 `0010e3c5...` 中，Step 59 (`USER_INPUT`) 与 Step 60 (`PLANNER_RESPONSE`) 的 `created_at` 均为 `2026-08-19T02:59:19Z`。
  - 如果一个包含多次工具调用的复杂任务耗时 2 分钟，最终回答 step 的创建时间通常落在推理开始之前或之中，绝非完成之时。
- **ChatGPT**：DOM 中**完全不存在原生时间戳**。
  - 当前适配器记录的 `completed_at` 实为 **Rally 本地观测时间 (Observation Time)**。
  - 若直接比较：当 IDE 在 10:00:00 创建步骤并执行至 10:05:00 完成，而 Browser 在 10:02:00 完成，此时 IDE 时间戳（10:00:00）会被判定早于 Browser（10:02:00），导致“明明 IDE 刚刚完成，红点却指向 Browser”的严重逻辑翻转！

### 8.2 精度与碰撞风险 (Precision & Tie Risks)
- Antigravity 仅提供**秒级**精度（格式 `YYYY-MM-DDTHH:mm:ssZ`，不含毫秒）。
- ChatGPT 的本地观测时间为毫秒级（`toISOString()`）。
- 两个异步系统在秒级粒度极易发生碰撞（Tie），且由于时钟不同源，无法确定因果序。

### 8.3 时钟漂移与离线重构漂移 (Clock Skew & Reconstruction Skew)
- **物理时钟偏差**：云端/服务端生成的 Antigravity 时间与运行 Chrome 的本地主机时钟天然存在未知偏差（毫秒至秒级）。
- **离线重构时间灾难**：如果 Rally 在系统休眠或关机 3 小时后重新启动并重新扫描 Browser 标签页，此时重新为 Browser 打上当前时间戳（`new Date()`），会导致陈旧的 Browser 历史结果瞬间“覆盖”IDE 在离线前产生的较新结果。

### 8.4 裁决小结
跨端点原生时间戳在语义、物理时钟源和精度上**均不可直接比较**。跨端点时序策略必须定为 **`PROVIDER_LOCAL_ORDER_ONLY`**。

---

## 9. Phase 1 最新结果指示器确定性规则 (Deterministic Rule)

在 `PROVIDER_LOCAL_ORDER_ONLY` 约束下，Phase 1 最新结果指示器（红点 / Latest Result Indicator）遵循以下确定性无歧义规则：

### 9.1 端点本地事实派生规则
1. **Browser 侧**：
   - 依赖原子核验后的 Chrome DOM。
   - 若 `isGenerating === true`：作为非变异瞬态，不改变现有规范结果事实。
   - 若稳定存在非占位最后一条 Assistant 消息：计算 `chatgpt_msg_<id>`。
   - 若该游标不等于上次 handled 游标，则 Browser 端点状态派生为 `NEW`。
2. **IDE 侧**：
   - 依赖 `HYBRID_PRIMARY` 机制。
   - 运行时通过 Stop Hook 触发；启动时通过 `transcript.jsonl` 重建。
   - 提取最新完成 turn 的 `ag-step:<stepIndex>:<fingerprint>`。
   - 若该游标不等于上次 handled 游标，则 IDE 端点状态派生为 `NEW`。

### 9.2 全局红点显示裁决规则 (Deterministic Red-Dot Rule)
根据 Phase 1 产品定义与 `CONTEXT.md` 规范：**Endpoint Result 彼此独立，Browser 与 IDE 可以同时各自拥有 NEW 结果**。

1. **红点激活条件**：
   $$\text{HasAttention} = (\text{Browser.State} == \text{NEW}) \lor (\text{IDE.State} == \text{NEW}) \lor (\text{HumanIntervention} == \text{ACTIVE})$$
2. **红点位置指示（单指示器模式下的偏序裁决）**：
   - **单端 NEW**：若仅有一端为 `NEW`（如 Browser=NEW, IDE=NO_NEW_RESULT），指示器明确指向该端点。
   - **两端均为 NEW (Dual NEW)**：
     - 在 Phase 1 中，状态界面应**并列呈现两端的独立 NEW 状态徽标**，绝不强行消除其中一个。
     - 若紧凑托盘中仅存在单个指示器且两端均为 NEW，由 **Rally 协调器本地记录的最近一次进入受信任 NEW 状态的观察时序 (`latest_observed_transition_seq`)** 裁决视觉高亮，或显示 `BOTH_NEW` 联合状态；
     - **严禁**使用跨端点 `max(completed_at)` 数值进行比较。
   - **两端均无未处理结果 (Both Caught Up)**：指示器熄灭。
   - **任一端为 UNKNOWN**：该端点显示 UNKNOWN 警示，绝不掩盖另一端的 NEW，亦不推断为 caught-up。

---

## 10. 明确的 Fail-Closed 边界 (Explicit Fail-Closed Cases)

以下情况必须坚决 **Fail-Closed** 至 `UNKNOWN` 或阻断推进，严禁进行便利性猜测：

1. **会话/仓库归属失配 (Attribution Mismatch)**：
   - Browser 标签页 URL 与绑定 `conversation_id` 不符；
   - IDE Stop Hook 或 transcript 路径对应的目录与绑定的 `conversation_id`、`workspace_identity`、`repository_identity` 无法严格三合一对齐。
2. **占位符污染 (Placeholder Result)**：
   - Browser 检测到最后一条消息为 `request-placeholder-*` 或空 ID；
   - 拒绝将其录入为完成游标，端点标记为 `continuity_lost`。
3. **历史游标漂移与截断 (Cursor Drift / Truncation)**：
   - 重启恢复时，先前记录的 `last_handled_cursor` 在 `transcript.jsonl` 中无法按 `stepIndex` 与 `fingerprint` 精确对齐（例如会话历史被裁剪或重置）；
   - 立即 fail-closed 至 `UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION`。
4. **生成中状态不可升级 (In-Progress Guard)**：
   - 检测到 `button[data-testid="stop-button"]` 存在时，不得将已有 UNKNOWN 错误升级为 TRUSTED，不得更新现有游标。
5. **Git 跟踪保护 (Tracked Hook Protection)**：
   - 若工作区 `.agents/hooks.json` 已被 Git 跟踪，拒绝自动静默修改，返回待用户决策。

---

## 11. 剩余风险与工作边界 (Remaining Risks & Scope Guardrails)

1. **ChatGPT 历史编辑/重新生成 (Branch Switch)**：
   - 实测表明：当用户在 ChatGPT 界面点击分支切换按钮时，DOM 中的最后一条消息 ID 会立刻变更。
   - 影响与处理：现有 DOM 探针始终读取当前激活分支的最后一条消息，符合“以当前展示页面为准”的直觉；如果切到旧分支，游标发生变化可能触发新的观察，这在 Phase 1 中应被作为端点内容更新安全吸收，不破坏系统稳定性。
2. **边界守卫 (Scope Guardrails)**：
   - 本研究成果**不包含**消息发送确认 (#32 delivery receipt)；
   - **不构建**浏览器全量 Message Ledger；
   - **不实现** #27 的代码变更或红点 UI 渲染。
   - 调查到此完整满足 Issue #35 交付条件。
