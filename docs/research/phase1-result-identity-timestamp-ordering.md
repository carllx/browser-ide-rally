# Phase 1 研究报告：跨端点结果身份、时间戳与时序裁决机制

> **研究任务标识**：GitHub Issue #35 (Phase 1 Result Identity & Timestamp Ordering)  
> **关联规范与映射**：#33 (Spec), #15 (ChatGPT Browser Seam), #16 (Antigravity IDE Seam), #27 (Observation Runtime)  
> **交付物定位**：`docs/research/phase1-result-identity-timestamp-ordering.md`  
> **当前修订版本**：Rev 3 (基于 Browser Re-review 窄口终局门禁：解决 ChatGPT branch navigation vs new completion 歧义，收紧 Browser 分类至 BROWSER_MINIMUM_GAP，确立未见证游标变更 Fail-Closed 规则)  
> **执行环境**：macOS (Darwin arm64), Google Chrome (AppleScript JS 注入), Antigravity Runtime/Filesystem (`~/.gemini/antigravity`)

---

## 1. 核心分类结论 (Required Classifications)

依据在真实 ChatGPT 浏览器环境与 Antigravity 本地运行时/文件系统获得的现场实证，给出三项最终核心裁决：

| 分类维度 | 裁决结果 | 核心判据概述 |
|---|---|---|
| **Antigravity 来源策略** | **`HYBRID_PRIMARY`** | 单独依赖运行时 Stop Hook 无法满足进程重启/休眠后的离线恢复（错过瞬态 IPC 事件）；单独依赖 `transcript.jsonl` 在并发/多步执行时缺乏终结性凭据，且可能因中间思考步骤产生虚假完成。必须以**运行时 Stop Hook 作为终结性证据 (Finality Evidence)**，以**落盘 transcript.jsonl 作为持久化顺序与重建真值 (Persisted Ordering & Reconstruction Truth)**。 |
| **跨端点最新结果排序** | **`PROVIDER_LOCAL_ORDER_ONLY`** | 两个端点各自在其内部具备严格且单调的偏序（Browser 依 DOM 树文档序与 UUIDv4，IDE 依单调 `step_index`）；但跨端点时间戳**语义严重不对称且不可比**（Browser 无原生时间戳，仅有 Rally 观测时间；IDE `step.created_at` 精度仅到秒且相邻记录共享时间戳，不能安全作为完成时间）。**严禁跨端点直接进行时间戳比对 (`DIRECT_TIMESTAMP_ORDERING`)**。若在观察空白期缺乏完整在线时序证明，必须 fail-closed 判定为 `UNCERTAIN`。 |
| **Browser 端点充分性** | **`BROWSER_MINIMUM_GAP`** | **[Classified: GAP]** 实机实证表明：在 Rally 在线持续监视（Live Witnessed）下，现有 DOM 探针能准确捕捉从生成中到定格的完成生命周期；但在**观察空白期 / 重启恢复 (Observation Gap / Restart Reconciliation)** 场景中，仅凭静态 DOM **无法区分当前未见过的游标是刚刚生成的新完成，还是用户在离线期间切换到了已存在的历史分支**（两者静态均无 `stop-button` 且仅表现为 `data-message-id` 变化）。因此存在最小语义 Gap，在观察空白期后发生的未见证 Browser 游标前进，Latest Result Indicator **必须严格 Fail-Closed 判定为 `UNCERTAIN`**。无需亦严禁引入全量 Message Ledger。 |

---

## 2. 证据分级规范 (Evidence Taxonomy)

本文档严格区分以下三类证据属性：
- **[Verified - 已验证]**：在当前真实生产环境（Chrome 活跃标签页、Antigravity 真实 transcript/hook 交互）或现有自动化测试中实际执行并复现的第一手客观证据。
- **[Reported - 已报告]**：来自产品架构规范、官方接口文档、已关闭 Issue 契约（#15, #16, #27, #33）明确声明并记录的行为。
- **[Inferred - 已推断]**：基于底层工程原理、分布式系统时钟约束及实测现象逻辑推导出的技术结论。

---

## 3. 真实探针与受检上下文 (Executed Probes & Targets)

本研究针对本地真实活跃环境执行了无副作用的只读探测与极窄专项检验：

1. **ChatGPT 真实会话、Reload 稳定性与分支导航深度探针**：
   - **目标会话**：`6aaf3983-844c-83e9-bcdb-5fcb59afd442`（URL: `https://chatgpt.com/g/g-p-6aa6259857808191af5554e99e447495-browser-ide-rally/c/6aaf3983-844c-83e9-bcdb-5fcb59afd442`）。
   - **[Verified] 极窄 Reload 现场实测**：
     - 刷新前读取：`count: 3, lastId: 'd9356c40-53ea-442a-b534-f407bb05e1aa'`；
     - 触发标签页 `reload` 并轮询等待 `document.readyState === 'complete'`；
     - 刷新后读取：`ready: true, count: 3, lastId: 'd9356c40-53ea-442a-b534-f407bb05e1aa'`；
     - 比对结果：前后 ID 严格一致（`EXACT MATCH`），一手证明已稳定落盘的消息 ID 在重载后完全稳定。
   - **[Verified] 分支导航 vs 新完成生命周期现场探针**：
     - 探针遍历提取当前 Assistant 节点属性：仅暴露 `data-message-id`、`data-message-author-role`、`data-turn-start-message`、`data-message-model-slug`，DOM 树上完全无任何生成时刻时间戳；
     - 机制比对证实：新生成生命周期伴随 `button[data-testid="stop-button"]` 出现至消失，必须由持续在线监视（Live Witnessed）捕获；而历史分支切换与离线新生成在静态 DOM 呈现上**完全无差异**，均处于非生成静止态。
2. **Antigravity 真实会话与文件系统探测**：
   - **当前活跃会话**：`0212808d-3d2f-43e2-80ad-dcd4c247287b`。
   - **多轮历史样本会话**：`0010e3c5-0bb8-47ec-ae51-8ebcef46f5d4`、`00ed06b9-bfa5-43e7-8c42-bf354dfb3aec`（提取自本地 `~/.gemini/antigravity/brain/` 下 579 个真实对话目录）。
   - **[Verified] 合成残缺尾部 (Synthetic Partial Tail) 容错实测**：构造尾部含残缺 JSON 行的文件，验证适配器解析器安全抛弃残缺行，不崩溃亦不虚构完成；
   - **[Observed] 当前环境文件布局观察**：追踪会话期间 `transcript.jsonl`，在当前测试环境中观察到 Inode 固定为 369447098 且文件大小持续单调递增。

---

## 4. ChatGPT 浏览器证据表 (Browser Evidence Table)

| 探测字段 / 特性 | 是否可用 | 稳定身份/顺序? | 语义类别 | 提供方来源? | 重启/刷新可查? | Phase 1 判定与证据说明 |
|---|---|---|---|---|---|---|
| `data-message-id` | **可用** [Verified] | **是**（唯一 UUID）[Verified] | Result Identity (消息唯一身份) | **是**（服务端分配）[Verified] | **是** [Verified] | **SAFE (用于在线识别)**：在 DOM 中稳定存在；刷新前后严格一致；严格过滤 `placeholder-*` 与 `request-placeholder-*` 后作为 `chatgpt_msg_<id>` 游标。 |
| 在线生成生命周期 (`stop-button`) | **可用** [Verified] | **是**（在线见证标志）[Verified] | Generation Lifecycle Indicator | **是**（前端状态）[Verified] | 否（仅在线瞬态）[Verified] | **SAFE (用于在线见证)**：`button[data-testid="stop-button"]` 从存在到消失是判定真正产生新 completion 的必要在线证据。 |
| 分支导航 DOM 标记 (Branch Pager) | **条件可用** [Verified] | 否（仅反映当前选中的分支索引）[Verified] | UI Branch Navigation State | **是**（前端状态）[Verified] | 否 | **UNSAFE 作为完成证明**：分支翻页器仅表达“当前展示第 N/M 个分支”，无法证明该分支是刚刚新生成的还是历史上早已存在的分支。 |
| `<time>` 元素与时间属性 | **不可用** (匹配数: 0) [Verified] | 否 | N/A | 否 | 否 | **UNSAFE**：DOM 树中不存在 `<time>` 标签，亦无任何包含 `time/date/created/updated/timestamp` 的 DOM 属性。 |
| 离线静态区分能力 (Offline Disambiguation) | **完全不可用** [Verified] | 否 | N/A | 否 | 否 | **BROWSER_MINIMUM_GAP**：在观察空白期之后，仅凭静态 DOM **无法区分是产生了新 completion 还是切换到了历史分支**。 |
| Rally Adapter `completed_at` | **可用** [Verified] | 仅为本地观察序 [Inferred] | Rally Observation Time (本地观测时刻) | **否**（Rally 本地时钟）[Verified] | 否（重启会变）[Inferred] | **CONDITIONAL**：仅能作为本地观测登记时间，绝对不能作为跨端点权威完成时间进行数学比较。 |

---

## 5. Antigravity 运行时与持久化文件证据表

### 5.1 Antigravity 运行时 (Stop Hook)
- **Stop Hook 进程触发 [Verified]**：在任务 `fullyIdle=true` 且 `terminationReason='NO_TOOL_CALL'` 时触发，是 Agent 不再产生动作的权威收敛信号（Finality Evidence）。
- **Hook 触发时间戳 [Verified]**：载荷自身不含服务端时间戳，接收时刻由 Bridge / Rally 记录，属瞬态 IPC，重启后不可重现。

### 5.2 Antigravity 持久化文件 (transcript.jsonl)
- **`step.step_index` [Verified]**：严格自增整型（0, 1, 2, ...），构成端点内部严格全序。
- **Content Fingerprint [Verified]**：SHA-256 前 16 位，与 `step_index` 组合构成 `ag-step:<idx>:<hash>`，防御历史截断或漂移。
- **`step.created_at` [Verified]**：格式为 UTC ISO 8601，秒级精度。实测证实其与紧邻的 `USER_INPUT` 频繁共享同一秒数值；确切内部语义归类为 **Unverified**，但已充分证实其**不能安全作为跨端点完成时间戳**。
- **写入与容错 [Verified]**：合成残缺行测试证实适配器解析器安全忽略半行尾部；当前测试环境观察到文件以 Append 方式增长。
- **文件系统 `mtime` [Verified]**：单日志文件结构下易受外部工具和 touch 污染，严禁作为结果真值。

---

## 6. 运行时 vs 文件 vs 混合模式权衡矩阵 (Tradeoff Matrix)

| 评估维度 | 方案 A: RUNTIME_PRIMARY (纯 Hook 驱动) | 方案 B: FILE_PRIMARY (纯文件轮询) | 方案 C: HYBRID_PRIMARY (混合模式，推荐) |
|---|---|---|---|
| **实时性与终结性** | 极高，终结性强（`fullyIdle: true`） | 延迟受限，缺乏终结性凭据 | **极高，终结性极强**（Hook 保证终结） |
| **重启与离线重构** | **致命缺失**（离线瞬态丢失） | 强（日志文件可回放） | **极强**（文件日志提供离线真值） |
| **综合裁决** | ❌ 无法满足离线可恢复性 | ❌ 易被中间未完成态误导 |  **唯一满足 Phase 1 全部契约的策略** |

---

## 7. 跨端点时间戳与排序对比 (Cross-Provider Comparison)

### 7.1 语义不对称与精度缺失
- Antigravity `step.created_at` 精度仅到秒且与紧邻记录共享数值；ChatGPT DOM 完全无原生时间戳，仅有本地观察时间。严禁直接做 `max(timestamp)` 比对。

### 7.2 观察空白期双端并发推进 (Offline Concurrent Advance)
- 当 Rally 离线期间，Browser 和 IDE 双端游标均向前推进时，由于缺乏可信跨端物理时间戳，启动时适配器的读取次序纯属内部调度细节。**必须严格 Fail-Closed 判定为 `UNCERTAIN`**。

### 7.3 分支导航与未见证游标前进的歧义性 (Branch Navigation vs Unwitnessed Advance)
- **场景**：Rally 离线期间，用户在 ChatGPT 标签页点击 `< 1/2 >` 切换到了过去生成的分支，导致最后一条消息的 `data-message-id` 变更；
- **歧义性**：Rally 重新连接后，仅看到 Browser 当前游标与持久化游标不同。由于静态 DOM 无原生时间戳，Rally 无法区分这究竟是“离线时刚产生的新完成”还是“切换到了历史分支”；
- **裁决**：**未见证的 Browser 游标变更无法证明是新完成**，必须进入 Fail-Closed 保护。

---

## 8. Phase 1 最新结果指示器规则 (Deterministic Latest Result Indicator Rule)

### 8.1 与 Canonical `NEW / handled` 彻底解耦
- **关注点分离**：
  - **Canonical Attention Lifecycle (`NEW / handled`)**：回答端点结果是否已被用户/动作处理。
  - **Latest Result Indicator (红点)**：纯粹回答**“最新发生的可靠 completion 在哪一端”**。
- **解耦关键不变量**：
  - **Mark handled 绝不移动或清除红点**：将某端点标记为 handled 仅推进其注意力事实，绝不改变其物理上是最新完成的事实；
  - **Dual NEW 不是红点不确定的定义**：两端可以同时为 `NEW`；只要在线见证了先后顺序，红点依然能明确指向后完成的一端；
  - **红点模糊 (Ambiguity) 的唯一根源是跨端时序证据缺失**。

### 8.2 确定性红点裁决算法
定义系统处于以下四种最新结果指示态之一：`BROWSER_LATEST`、`IDE_LATEST`、`UNCERTAIN`、`NONE`：

1. **在线见证推进 (Live Witnessed Advance)**：
   - 若 Rally 持续在线运行，并见证了明确的因果生成生命周期（Browser 经历 `stop-button` 生成闭环，或 IDE 收到带 `fullyIdle=true` 的 Stop Hook），且具有明确的在线观察序列号 `seq_A < seq_B`，则指示器明确指向后完成的一端。
2. **离线单端推进裁决 (Offline Single-Endpoint Advance)**：
   - 若在 Rally 离线/观察空白期之后：
     - **仅 IDE 端推进**（Browser 游标完全未变，IDE `step_index` 单调自增）：由于 Browser 未发生任何变动，明确判定为 **`IDE_LATEST`**；
     - **仅 Browser 端推进（未见证游标变更）**：由于静态 DOM 无法排除是历史分支导航还是离线新生成，**必须 Fail-Closed 判定为 `UNCERTAIN`**，直到出现下一次在线见证的完成。
3. **离线双端并发推进 (Offline Dual Advance)**：
   - 若离线空白期后检测到 **Browser 与 IDE 双端游标均发生变更**：
   - 跨端时序证据完全缺失，**强制 Fail-Closed 判定为 `UNCERTAIN`**。
4. **结果处理操作 (`markEndpointHandled`)**：
   - 仅改变对应端点的注意力状态（`NEW -> NO_NEW_RESULT`）；
   - **红点位置与状态完全保持不变**。

---

## 9. 明确的 Fail-Closed 边界 (Explicit Fail-Closed Cases)

1. **未见证的 Browser 游标推进**：观察空白期后出现的 Browser 游标变更，无法排除分支导航，Latest Result Indicator 强制判定为 `UNCERTAIN`。
2. **离线双端并发推进**：观察空白期后两端游标双双变更，强制判定为 `UNCERTAIN`。
3. **会话/仓库归属失配**：URL 或工作区/仓库不匹配，对应端点进入 `continuity_lost`，指示器判定为 `UNCERTAIN`。
4. **占位符过滤**：检测到 `request-placeholder-*` 拒绝提交完成游标。
5. **历史游标截断/漂移**：重启时 `handled_cursor` 在 transcript 中无法按 `stepIndex` 与 `fingerprint` 精确对齐，强制 fail-closed 至 `UNKNOWN_UNTIL_NEXT_OBSERVED_COMPLETION`。
6. **生成中不更新**：`stop-button` 存在时作为运行时暂态，不升级 trust，不改写最新结果。

---

## 10. 剩余风险与工作边界 (Remaining Risks & Scope Guardrails)

1. **窄口语义 Gap 的边界收敛**：
   - 将 Browser 判定为 `BROWSER_MINIMUM_GAP` 并对未见证游标变更实施 `UNCERTAIN` 守卫，完全在现有 Phase 1 契约内闭环了安全隐患；
   - 绝不需要为了消除此 Gap 而引入重型的全量 Message Ledger 或 private SSE 探测。
2. **工作边界守卫**：
   - 本研究**不包含**消息发送确认 (#32 delivery receipt)；
   - **不实现** #27 的代码变更或红点 UI 渲染；
   - **不执行分支合并或集成**（等待 Browser Lead 独立将文档落到 clean main）。
   - 调查与修订到此完整满足 Issue #35 全部终局门禁。
