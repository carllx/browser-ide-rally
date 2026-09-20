# Phase 1 研究报告：跨端点结果身份、时间戳与时序裁决机制

> **研究任务标识**：GitHub Issue #35 (Phase 1 Result Identity & Timestamp Ordering)  
> **关联规范与映射**：#33 (Spec), #15 (ChatGPT Browser Seam), #16 (Antigravity IDE Seam), #27 (Observation Runtime)  
> **交付物定位**：`docs/research/phase1-result-identity-timestamp-ordering.md`  
> **当前修订版本**：Rev 2 (基于 Browser Review 要求修正：离线并发前进 Fail-Closed、指标与 NEW/handled 彻底解耦、收紧语义措辞、补入 reload 实测)  
> **执行环境**：macOS (Darwin arm64), Google Chrome (AppleScript JS 注入), Antigravity Runtime/Filesystem (`~/.gemini/antigravity`)

---

## 1. 核心分类结论 (Required Classifications)

依据在真实 ChatGPT 浏览器环境与 Antigravity 本地运行时/文件系统获得的现场实证，给出三项核心裁决：

| 分类维度 | 裁决结果 | 核心判据概述 |
|---|---|---|
| **Antigravity 来源策略** | **`HYBRID_PRIMARY`** | 单独依赖运行时 Stop Hook 无法满足进程重启/休眠后的离线恢复（错过瞬态 IPC 事件）；单独依赖 `transcript.jsonl` 在并发/多步执行时缺乏终结性凭据，且可能因中间思考步骤产生虚假完成。必须以**运行时 Stop Hook 作为终结性证据 (Finality Evidence)**，以**落盘 transcript.jsonl 作为持久化顺序与重建真值 (Persisted Ordering & Reconstruction Truth)**。 |
| **跨端点最新结果排序** | **`PROVIDER_LOCAL_ORDER_ONLY`** | 两个端点各自在其内部具备严格且单调的偏序（Browser 依 DOM 树文档序与 UUIDv4，IDE 依单调 `step_index`）；但跨端点时间戳**语义严重不对称且不可比**（Browser 无原生时间戳，仅有 Rally 观测时间；IDE `step.created_at` 精度仅到秒且相邻记录共享时间戳，不能安全作为完成时间）。**严禁跨端点直接进行时间戳比对 (`DIRECT_TIMESTAMP_ORDERING`)**。若在观察空白期两端游标均发生推进，必须 fail-closed 判定为 `UNCERTAIN`。 |
| **Browser 端点最小充分性** | **`BROWSER_MINIMUM_SUFFICIENT`** | 现有基于 `#15` 的 DOM 探针缝隙（原子核验 URL + 排除 `stop-button` 生成中 + 过滤占位 ID + 提取最终 `data-message-id`）经现场 reload 实测验证，对于 Phase 1 所需的**结果身份唯一定位、完成状态判定与页面重载持久性已完全充分**。实证表明无需亦严禁擅自引入重型的全量 Message Ledger。 |

---

## 2. 证据分级规范 (Evidence Taxonomy)

本文档严格区分以下三类证据属性：
- **[Verified - 已验证]**：在当前真实生产环境（Chrome 活跃标签页、Antigravity 真实 transcript/hook 交互）或现有自动化测试中实际执行并复现的第一手客观证据。
- **[Reported - 已报告]**：来自产品架构规范、官方接口文档、已关闭 Issue 契约（#15, #16, #27, #33）明确声明并记录的行为。
- **[Inferred - 已推断]**：基于底层工程原理、分布式系统时钟约束及实测现象逻辑推导出的技术结论。

---

## 3. 真实探针与受检上下文 (Executed Probes & Targets)

本研究针对本地真实活跃环境执行了无副作用的只读探测与极窄专项检验：

1. **ChatGPT 真实会话与 Reload 稳定性探测**：
   - **目标会话**：`6aaf3983-844c-83e9-bcdb-5fcb59afd442`（URL: `https://chatgpt.com/g/g-p-6aa6259857808191af5554e99e447495-browser-ide-rally/c/6aaf3983-844c-83e9-bcdb-5fcb59afd442`）。
   - **DOM 属性深度探针**：遍历提取所有 Assistant 消息属性，全面排查 `<time>` 标签、文本时间戳、React Fiber 内部挂载节点、`window.__NEXT_DATA__`、全局状态变量。
   - **[Verified] 极窄 Reload/Reopen 现场实测**：
     - 刷新前读取：`count: 3, lastId: 'd9356c40-53ea-442a-b534-f407bb05e1aa'`；
     - 通过 AppleScript 触发标签页 `reload`，轮询等待 `document.readyState === 'complete'`；
     - 刷新后读取：`ready: true, count: 3, lastId: 'd9356c40-53ea-442a-b534-f407bb05e1aa'`；
     - 比对结果：前后 ID 严格一致（`EXACT MATCH`），一手证明最后完成 Assistant 消息 ID 在重载后完全稳定。
2. **Antigravity 真实会话与文件系统探测**：
   - **当前活跃会话**：`0212808d-3d2f-43e2-80ad-dcd4c247287b`。
   - **多轮历史样本会话**：`0010e3c5-0bb8-47ec-ae51-8ebcef46f5d4`、`00ed06b9-bfa5-43e7-8c42-bf354dfb3aec`（提取自本地 `~/.gemini/antigravity/brain/` 下 579 个真实对话目录）。
   - **时序与时间戳分析**：逐行分析 `transcript.jsonl`，检验 `step.created_at` 变化与相邻 step 共享时间戳现象。
   - **并发与追加写入观察**：
     - **[Verified] 合成残缺尾部 (Synthetic Partial Tail) 容错实测**：构造尾部含残缺 JSON 行的文件，验证适配器解析器安全抛弃残缺行，不崩溃亦不虚构完成；
     - **[Observed] 当前环境文件布局观察**：追踪会话期间 `transcript.jsonl`，在当前测试环境中观察到 Inode 固定为 369447098 且文件大小持续单调递增。

---

## 4. ChatGPT 浏览器证据表 (Browser Evidence Table)

| 探测字段 / 特性 | 是否可用 | 稳定身份/顺序? | 语义类别 | 提供方来源? | 重启/刷新可查? | Phase 1 判定与证据说明 |
|---|---|---|---|---|---|---|
| `data-message-id` | **可用** [Verified] | **是**（唯一 UUID）[Verified] | Result Identity (消息唯一身份) | **是**（服务端分配）[Verified] | **是** [Verified] | **SAFE**：在 DOM 中稳定存在；经实机 reload 探测证实刷新前后严格一致；严格过滤 `placeholder-*` 与 `request-placeholder-*` 后作为 `chatgpt_msg_<id>` 游标。 |
| `<time>` 元素 | **不可用** (数量: 0) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：DOM 树中不存在 `<time>` 标签。 |
| `data-message-time` 等时间属性 | **不可用** (匹配数: 0) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：遍历所有属性及子元素，无任何包含 `time/date/created/updated/timestamp` 的 DOM 属性。 |
| `window.__NEXT_DATA__` | **不可用** (`false`) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：客户端运行时未暴露该全局对象。 |
| React Fiber Internal Props | **不可用** (`hasFiberKey: false`) [Verified] | 否 | 内部私有状态 | 否 | 否 | **UNSAFE**：DOM 元素未暴露可访问的 Fiber 状态，侵入抓取脆弱且不可靠。 |
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
| `step.step_index` | **可用** [Verified] | **是**（严格自增整型）[Verified] | Monotonic Sequence Identity | **是**（IDE 核心逻辑）[Verified] | **是** [Verified] | **SAFE**：单调递增整数（0, 1, 2, ...），构成端点内部严格全序。 |
| Content Fingerprint | **可用** [Verified] | **是**（SHA-256 前 16 位）[Verified] | Content Drift Detection | **是**（派生自内容）[Verified] | **Yes** [Verified] | **SAFE**：与 `step_index` 组合构成不透明游标 `ag-step:<idx>:<hash>`，防御历史截断或漂移。 |
| `step.created_at` | **可用** [Verified] | 弱单调（存在相邻同秒）[Verified] | **精确内部语义未验证 (Unverified)**；实测证实非可信完成时间 [Verified] | **是**（系统时钟）[Verified] | **是** [Verified] | **UNSAFE 作为跨端完成时序**：格式为 UTC ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`)，秒级精度。实测证实其与紧邻的 `USER_INPUT` 频繁共享同一秒数值；因缺乏官方源码定义，精确内部语义归类为 Unverified，但已充分证实其**不能安全作为跨端点完成时间戳**。 |
| `step.type === 'PLANNER_RESPONSE'` & `status === 'DONE'` & `tool_calls.length === 0` | **可用** [Verified] | **是**（完成轮次模式）[Verified] | Completed Result Identification | **是** | **是** [Verified] | **SAFE**：准确从众多中间工具调用中过滤出最终呈现给用户的响应。 |
| 写入方式 (当前环境观察) | **追加写入** [Observed] | Inode 保持不变，文件持续累加 [Observed] | Current Observed Stream Layout | **是** | **是** [Observed] | **OBSERVED**：在当前 macOS 测试环境下观察到 Inode 固定且大小递增；但这属于当前环境实测表现，不作为提供方跨版本永久保证的不变公理。 |
| 并发读取半行尾部 (Partial Tail) | **解析器具备容错** [Verified] | 格式校验守卫 [Verified] | Fault-Tolerant Parse Robustness | **是**（适配器防卫能力）[Verified] | **是** [Verified] | **SAFE**：通过合成残缺 JSON 行实测证明，适配器解析器在读取到半行尾部时安全忽略该行，不崩溃亦不虚构完成。 |
| 文件系统 `mtime` | **可用但不稳定** [Verified] | 易受污染 [Verified] | OS File Modified Time | 否（受 OS / 外部工具影响） | 否 | **STRICTLY UNSAFE**：整个会话仅单个日志文件，`mtime` 仅反映最后一次写操作；任何工具访问、Spotlight 索引或 touch 都会改动它，严禁作为结果真值。 |

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

### 8.1 语义不对称与精度缺失
- **Antigravity**：`step.created_at` 精度仅到秒。在会话 `0010e3c5...` 中，Step 59 (`USER_INPUT`) 与 Step 60 (`PLANNER_RESPONSE`) 的 `created_at` 完全相同（`02:59:19Z`）。实证表明其无法反映亚秒级时序，亦不能断言代表了推理结束时刻。
- **ChatGPT**：DOM 中完全不存在原生时间戳，仅有适配器在本地执行探针时的 `completed_at` (Observation Time)。
- **严禁直接比对**：若长耗时任务在 IDE 运行，两端时间戳不仅时钟源不同，而且一个是服务端的秒级记录，一个是本地毫秒级观测，数学大小比对毫无物理意义。

### 8.2 离线并发推进导致的跨端时序缺失 (Offline Concurrent-Advance Gap)
- **核心场景**：当 Rally 离线（未运行、休眠或崩溃）期间，Browser 和 IDE 两个端点**均发生了新的完成 (Both cursors advanced offline)**。
- **扫描顺序不可作为时序**：Rally 启动时，无论先扫描 Chrome 标签页还是先读取 IDE transcript，其先后顺序纯属内部调度细节，**绝不能**作为物理发生顺序。
- **确定性裁决**：此时跨端点完全缺乏可信的先后时序证据，**必须 Fail-Closed 判定为 UNCERTAIN / UNKNOWN**。

---

## 9. Phase 1 最新结果指示器规则 (Deterministic Latest Result Indicator Rule)

### 9.1 与 Canonical `NEW / handled` 彻底解耦
- **职责划分**：
  - **Canonical Attention Lifecycle (`NEW / handled`)**：回答“此端点结果是否已被用户/动作流转处理”。
  - **Latest Result Indicator (最新结果指示器 / 红点)**：纯粹回答**“最新发生的可靠 completion 在哪一个端点”**。
- **解耦关键不变量**：
  - **Mark handled 绝不移动或清除红点**：将某端点标记为 handled 仅更新其注意力事实，绝不改变“它是最后完成的一端”这一物理历史；
  - **Dual NEW 不是红点不确定的定义**：两端可以同时为 `NEW`（均未处理）；只要 Rally 实时目睹了先完成 A、后完成 B，红点依然能够明确指向 B；
  - **红点模糊 (Ambiguity) 的唯一根源是跨端时序证据缺失**（即观察空白期两端均有推进）。

### 9.2 确定性红点裁决算法
定义系统处于以下三种最新结果指示态之一：`BROWSER_LATEST`、`IDE_LATEST`、`UNCERTAIN`（以及两端均无任何完成时的 `NONE`）：

1. **单端推进 (Single-Endpoint Advance)**：
   - 若在离线重构或当前状态下，仅有一端较基线推进了新游标，另一端未动，则指示器明确指向发生推进的端点（`BROWSER_LATEST` 或 `IDE_LATEST`）。
2. **在线单调见证 (Live Monitored Succession)**：
   - 若 Rally 持续在线运行，并在物理时间轴上先后接收到两端的完成观察（即具有明确的 Rally 观察序列号 `seq_A < seq_B`），则指示器指向后观察到的一端。
3. **离线并发推进 (Offline Concurrent Advance -> UNCERTAIN)**：
   - 若在 Rally 离线/观察空白期之后，检测到 **Browser 游标与 IDE 游标较上次已知状态双双发生前进**；
   - 此时无法从端点元数据中证明谁真正更晚；
   - **严格 Fail-Closed**：指示器置为 **`UNCERTAIN`**（界面呈现为中立警示或双向不确定状态，绝不伪造单向指示）。
4. **单端结果处理 (`markEndpointHandled`)**：
   - 仅改变对应端点的 `NEW -> NO_NEW_RESULT`；
   - **红点位置保持不变**。

---

## 10. 明确的 Fail-Closed 边界 (Explicit Fail-Closed Cases)

1. **观察空白期双端推进**：Rally 离线恢复时若两端均推进新游标，Latest Result Indicator 强制判定为 `UNCERTAIN`。
2. **会话/仓库归属失配**：Browser URL 不匹配或 IDE 目录/仓库三合一失配，对应端点进入 `continuity_lost`，指示器判定为 `UNCERTAIN`。
3. **占位符过滤**：检测到 `request-placeholder-*` 拒绝提交完成游标。
4. **历史游标截断/漂移**：重启时 `handled_cursor` 在 transcript 中无法按 `stepIndex` 与 `fingerprint` 精确对齐，强制 fail-closed 至 `UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION`。
5. **生成中不更新**：`stop-button` 存在时作为运行时暂态，不升级 trust，不改写最新结果。

---

## 11. 剩余风险与工作边界 (Remaining Risks & Scope Guardrails)

1. **ChatGPT 分支切换 (Branch Navigation)**：DOM 探针跟踪当前激活分支的最后消息；切换分支会触发游标更新，在 Phase 1 中被作为端点内容更新安全吸收。
2. **工作边界守卫**：
   - 本研究**不包含**消息发送确认 (#32 delivery receipt)；
   - **不构建**浏览器全量 Message Ledger；
   - **不实现** #27 的代码变更或红点 UI 渲染。
   - 调查与修订到此完整满足 Issue #35 Review 要求。
