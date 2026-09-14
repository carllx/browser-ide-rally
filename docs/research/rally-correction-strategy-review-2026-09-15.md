# Browser-IDE Rally：纠偏策略与下一阶段独立架构审查

审查日期：2026-09-15（Asia/Shanghai）。仓库基线：`6b26f64`；产品源码仍为 `be4f02c` 候选。本文审查路线与证据，不实施 Relay，不修改既有 ADR，不发送 IDE/Browser 任务。

证据分级：**Verified**＝本审查亲自检查文件、执行本地探针或观察当前 UI；**Reported**＝用户或上一份项目报告声明，但本轮未独立重演；**Documented**＝当前官方文档描述，不代表当前账号可用；**Inferred**＝根据证据作出的架构判断或建议。以下所有设计建议均为 Inferred，不是已实现能力。

主要本地依据：[架构 ADR](/Users/yamlam/Documents/GitHub/browser-ide-rally/docs/architecture/decisions/0001-rally-architecture-contract.md)、[接口 Spike 报告](/Users/yamlam/Documents/GitHub/browser-ide-rally/docs/research/rally-interface-spike-2026-09-15.md)、[首轮完整审查](/Users/yamlam/Documents/GitHub/browser-ide-rally/docs/research/rally-full-architecture-review-2026-09-15.md)。

## A. Verdict

**MOSTLY RIGHT。纠偏抓住了真正的问题，但当前五阶段顺序不应原样执行。**

最重要的三个调整：

- 把“账号能力边界＋结果返回原 Browser 并触发可识别的继续”放到最前面的有界实验；不要先建设完整 Status Backbone。
- Binding、去重、拒绝过期消息、暂停和权限门禁必须在第一次自动执行之前存在，不能等 Phase 5。
- 撤回“Plus 已确定不能使用 actionable custom MCP”的事实判断。当前两份官方文档相互冲突；本账号尚未完成 Developer mode / 写工具实测。合理状态是 **UNVERIFIED**，不是已证实 **UNAVAILABLE**。

`be4f02c = NOT READY` 和 R1–R6 冻结仍成立。路线纠正属于设计进展，尚未修复产品可靠性，也尚未证明一轮真实交接。

## B. What Changed for the Better

1. **授权与生成观测分离。** 显式任务才是交接对象；SSE、DOM Stop、通知只能提供局部观测。这解决了上一轮最根本的目标漂移。
2. **现有 IDE 会话成为明确目标。** 本机 `agentapi --help` 确实列出 metadata、send-message、new-conversation；官方也记录了 `agentapi send-message <conversation_id> <prompt>`。已有 GUI 定向投递成功仍按项目实测报告标为 Reported，本轮未重发。该路线值得优先保留。[Antigravity Sidecars](https://antigravity.google/docs/sidecars)
3. **五类概念划分有用。** 任务、收据、结果、恢复不再被压进一个 `completed`；但五个概念不等于五套数据库或状态机。
4. **Inbox 降为可选视图。** Controller 的事实可同时供 Relay 和 Attention View 使用；后者不应成为前者的前置项目。
5. **冻结已知不可靠的候选与尚未证实必要的基础设施。** 不删除历史证据、不继续堆 detector 修复、不反复要求用户配置凭据，都是合理的投入控制。

## C. What Is Still Wrong

**“先看得清”仍可能把观测建设变成产品前置。** Browser `ready` 究竟表示有输入框、停止生成、愿意接受结果，还是允许执行下一步？IDE `idle` 来自真实 API、Hook 还是猜测？目前信号不足，先填满状态枚举只能制造假确定性。先实现一次真实 Exchange，再记录它实际产生的事实。

**把明显可行的一半放在最大未知项前面。** 已有 agentapi 注入证据；未知的是原 Browser 会话能否接受返回、确认持久化、继续推理。先做完整单向发送，可能把产品建在无法返回的桥头上。

**“显式 Envelope”尚缺生产入口。** MCP 不可用时，Browser 如何产生 Envelope？只写“explicit handoff”没有解决它。可验证两种入口：正式工具调用；或当前已绑定回复中带本轮 nonce、严格 schema 和闭合标记的专用交接块。后者仍需窄范围提取和校验，不能声称完全不读取 Assistant 内容，也不能扫描历史聊天任意 JSON 即执行。

**当前证据表再次出现越级。** Verified：接口报告把 Hybrid 的长任务续跑写成 YES，把 Passive 路线 Human Gate 写成 NO，并把整个 Gate 标为“只阻塞在 Tunnel 创建”。这些都超出已给证据。应分别记录账号权限、传输、精确路由、返回、续跑、审批语义，不能一个总标签代替。

**本地 MCP PASS 的范围过宽。** 本轮重跑原测试成功；但额外探针发现 `delay_ms: "0"` 被接受，违反声明的 number 输入类型。声明 schema 不等于严格验证。负数也被接受，不过现有 schema 没有 minimum，不能把这一点算作违反 schema。原 unknown-tool 测试的 catch 同时捕获自身“应当失败”的断言，会产生假阳性；独立探针确认当前实现实际会拒绝未知工具。结论是“本地正常路径与部分拒绝路径通过”，不是“严格契约通过”。

**ADR 有一处会影响安全的空白。** Binding 有 revision，Envelope 却只有 binding_id。发送前重新解析可变 Binding，会把旧任务送到新目标。必须把 revision 和目标快照固定到 Exchange，发送时比较；Result 再经不可变父请求关联到同一 attempt。没有必要把所有字段在所有消息重复一遍，但关联必须无歧义。

## D. Biggest Remaining Blind Spots

按潜在损害排序，最多七项：

1. **网页内容借 IDE 高权限执行。** 页面来源真实、JSON 合法、Conversation 正确，都不证明命令被授权。Reported 的 HIGH/system 投递尤其不能被当成“内容可信”；若现有 IDE 会话拥有宽泛工具权限，仅靠提示词中的 repo scope 不构成隔离。必须由执行端权限／sandbox 限制实际能力。
2. **目标检查后目标变化。** Browser 导航、账号切换、聊天分支；IDE root/child 会话混用、worktree 或分支改变；都会使曾经正确的 Binding 失效。只比较标题、URL 或 repo remote 不够。发送前最后一次校验与短期绑定许可必须属于同一操作。
3. **发送结果不明导致重复副作用。** Controller 在 send-message 成功后、记账前崩溃，无法仅凭本地状态判断是否发送。换 attempt_id 重试不能解决。没有接收端幂等／查询能力时，必须记为 delivery_unknown 并停止自动重发。
4. **用户介入与后台执行同时发生。** 用户改方向、改工作树、停止 Browser 时，IDE 可能还在写。Controller 暂停只能阻止后续派发，不能假装撤销已运行操作。需要单个在途任务、暂停闩锁，以及实际执行终止／隔离的证据。
5. **“回填”被当作“恢复”。** 文本进入输入框、点击 Send、聊天出现消息、Browser 理解对应结果，是四件不同的事。草稿、限流、登录失效、页面冻结、工具等待超时，都可能切断链路；回执必须覆盖需要保证的那一层。
6. **长任务与账号／模式能力被短探针掩盖。** 500ms stdio、60s 远程工具、普通聊天可选插件，都不能证明现有 Project、目标模式、休眠后恢复和数十分钟 IDE 任务可用。这里决定纯 MCP、混合或人工恢复的架构边界。
7. **状态和结果自己证明自己。** Hook 出现、HTTP 成功、Agent 说 completed、仪表盘显示绿色，均不是执行正确的独立证据。恶意或错误的 Result 也可能诱导下一轮扩大权限；必须把结果视为数据，用独立 artifact／操作计数／可见回执校验。

## E. Correct Product Sequence

建议顺序如下；产品化顺序应服从实验发现，而不是遵循原来的五阶段名称。

| 阶段 | 交付 | 进入下一阶段的条件 |
|---|---|---|
| 0：能力与最高风险验证 | 只读核实账号入口；用现有 Browser 自动化验证原会话返回和一次语义确认 | 明确哪些能力可用、哪些不可用、哪些仅未测；不因入口存在就判 MCP PASS |
| 1：一轮无害 Echo | 一个 Browser、一个现有 IDE 会话、一个固定 nonce 任务，一次完整往返 | 原目标收到对应结果；无复制粘贴；明确失败状态；不会再自动发下一任务 |
| 2：最小可靠交接 | 精确 Binding、不可变请求、最小持久记录、去重、暂停、超时、未知投递停止 | 错目标、重复、崩溃、迟到等反例不会引发额外副作用 |
| 3：一个有界真实任务 | 限定工作区和能力；显式 Result；独立验证产物 | 一次真实任务可审计地交回；真实权限门禁保留 |
| 4：有限连续执行 | 明确授权的少量轮次、总时长／成本限制、无进展停止 | 连续反例通过后才逐步扩大运行范围 |
| 后续：便利功能 | 更好的状态 UI、Inbox、主动恢复、多绑定、多任务 | 有真实使用需求，不以“架构完整”为理由提前建设 |

阶段 0 的返回测试可用固定伪 Result，先隔离 Browser 的困难；它不算完整 Relay。阶段 1 再用真实 IDE nonce 往返把两侧连起来。最小门禁从 Echo 起就限制为固定无害动作；真实执行之前升级到 J 节要求。

状态的消费者要分开：

| 消费者 | 真正需要的内容 |
|---|---|
| 用户 | 正在处理什么、卡在哪里、是否需要自己操作、暂停入口、最近一次有证据的进展 |
| Browser Agent | 当前请求的受理／结果／阻塞原因，以及是否被允许提出下一请求 |
| IDE Agent | 固定任务、目标工作区、能力边界、结果提交位置、取消／过期信息 |
| Controller | 不可变 ID 与版本、派发许可、去重依据、收据来源、超时和未决副作用 |

无需先做 Dashboard。一个 machine-readable Exchange 加简短文本视图足够。`IDE idle` 缺乏可信来源时显示 unknown；“可安全交接”是政策判定，不是页面观测字段。

## F. Minimum Phase 1

**明天只做一个现有 Browser ↔ 现有 Antigravity 的固定 Echo 往返，最多一个在途 Exchange。**

固定任务只要求 IDE 返回 nonce，不读写项目、不运行用户提供的 shell、不允许自动产生第二个任务。Browser 收到后只回一个包含同一 nonce 的确认。保留原 Web／Project／Conversation。

最少对象：

- 一个 Binding：Browser 的账号／工作区范围、conversation locator、IDE conversation、工作目录／repo、revision；首次绑定明确确认，后续匹配自动完成。
- 一个 Exchange：exchange_id、固定目标快照／revision、请求内容和摘要哈希、到期时间、发送事实、可验证的接收事实、结果、错误原因。不同 attempt 必须隶属于同一个逻辑任务，不能借换 ID 绕过去重。
- 一份很小的审计记录；一个暂停开关。固定 Echo 可以在进程丢失后直接停止并重建实验，不承诺恢复；任何后续有副作用的任务必须先落盘记录派发意图。

五类概念的最小实现：

| 概念 | 现在 | 后补 |
|---|---|---|
| Binding | 固定目标与 revision，不隐式改绑 | 自动发现、多目标管理 |
| Envelope | ID、明确动作、有效期、关联、完整内容校验 | 通用任务语言和复杂 artifact 类型 |
| ACK | 记录真实来源；没有 IDE accept 证据就保持未知 | 接收端持久幂等 ACK、复杂握手 |
| Result | 本轮关联、状态、摘要；Echo 只带 nonce | 多产物和丰富变更证据 |
| Recovery | 未知即停、禁止盲重试、可见原因 | 自动 crash resume 和跨进程对账 |

不要预造每个 Agent 的完整生命周期。一次 Exchange 可先记录 `prepared → dispatching → result_ready → delivered`，旁路为 `blocked / failed / delivery_unknown`；`accepted` 只在有真实证据时出现，`running` 可以暂时没有。状态转换和业务结果分开，不能将 `delivered` 当成业务验收通过。

真实任务的最小 Result 建议：`schema_version, result_id, request_message_id, status, summary, artifact_refs`。`status` 为 completed/failed/blocked；blocked 增加稳定 reason 和所需决定。attempt、Binding 通过不可变 request 追溯。修改代码时补工作目录／基线与实际变更标识、验证结果；无 commit 时允许 diff，不强制提交。不要把大日志、凭据和堆栈全部塞进 Result。

IDE 可以显式调用窄 `submit_result` 工具或写入 Controller 约定的结果文件；先校验真实完成条件。Stop Hook 可做诊断，不能成为这一阶段必须实现的完成判定系统。显式提交也不自动证明内容正确或后台子任务已停止。

## G. Alternative Strategy

**推荐替代方案：Risk-first + 最小 Round-trip-first。** 先验证返回，再连 Echo，从真实交接归纳状态。

| 方案 | 优点 | 主要代价／适用条件 |
|---|---|---|
| 当前 Status → 单向 → 返回 | 便于展示进度、逐步搭建模块 | 最晚才遇到关键不可行性；容易先造无证据状态 |
| 推荐的返回风险优先 | 尽早决定浏览器适配器、等待语义和账号路线；可丢弃实验代码 | 初期 UI 简陋；只证明一条窄路径 |
| 备选：显式双邮箱／收据 | Controller 暂存请求和结果，两端显式提交与领取；自然容纳长任务 | Browser 空闲后仍需要可用的触发入口；轮询不会凭空唤醒 ChatGPT |

双邮箱不需要新的 AI 协调者：Controller 是确定性程序。若 Browser 自动回送确实受阻，允许用户点击一次“领取结果”作为诚实的半自动降级，但不能把它验收为全自动闭环，也不能把半自动版本强行变成长远目标。

另外一条实质差异：结果先由 IDE 显式提交，避免先研究 Stop/fullyIdle 全生命周期。这比把 Browser detector 换成 IDE detector 更直接。

## H. Browser Adapter Recommendation

**当前最值得先验证：使用现有登录浏览器的 Browser Automation，作为可丢弃的验证工具。** 本轮已经能通过现有 Chrome 控制面读取 ChatGPT 页面并观察到 Plus 标识；这只证明可以访问页面，不证明已能提交结果、全天运行或自动恢复。

第一项动作应是：在获得测试消息发送授权后，给明确绑定的现有会话交回一个固定 nonce Result；发送前检查账号范围、conversation、目标回复／分支上下文和草稿；发送后读取实际出现的消息，必要时重载确认，再要求 Browser 对 nonce 作唯一确认。如果正在生成、有用户草稿、已导航或身份不明，则停止而非覆盖／强行点击。

这条实验路径保留真实 Web／Project／Conversation，能够先回答“回得来且继续得起来吗”。不要把 Codex 当前可调用的浏览器控制工具，直接当成 Rally 已拥有可部署的后台浏览器驱动。

| 候选 | 当前建议 | 决策理由／限制 |
|---|---|---|
| Browser Automation | 先做验证 | 现有环境可读页面；能直接检验真实使用方式；生产控制器的部署另验 |
| Tampermonkey | 保留为薄适配器候选 | 可承接精确页面定位、专用 Envelope、结果回填、有限 busy 观测；不恢复通用 completion 中心地位 |
| Chrome Extension | 在权限边界／tab 管理需求出现后优先评估 | 可把本地凭据与网页脚本分离，并收窄到允许的页面／本地主机；仍需验证生命周期和权限 |
| CDP／受控浏览器 | 诊断或受控测试备选 | 不默认能复用用户日常 profile；新 profile 会增加登录与上下文迁移成本 |
| ChatGPT MCP／Plugin | 保留条件优先资格 | 当前账号写工具与原对话实测通过后，优先用它表达意图；延迟结果是否需浏览器协助另验 |
| OpenAI API | 作为用户接受产品边界变化时的替代 | 可自建调用与任务循环，但不是自动延续现有 ChatGPT Web 会话，也不自动继承 Project 上下文 |
| Desktop app | 暂无已验证的更短路径 | 换客户端不能证明有原对话结果注入／恢复接口，不因安装存在就选用 |
| GPT Actions／其他官方入口 | 不作为默认绕路 | 必须验证账号可创建、现有对话兼容性和动作权限；不能拿另一个会话替代当前目标 |

Tampermonkey 的判断是 **2 为主、3 为辅，不选 1**：保留薄适配器，按需保留局部 lifecycle 观测。显式 Envelope 只需证明“这个请求完整且获准”，无需精确检测所有 `response.completed`。发送结果时仍需知道输入框是否可安全使用，但 unknown 可以停止，不必升级为万能生成分类器。

Conversation URL 只能作 locator：`/c/<id>` 不是官方承诺给 Rally 的永恒绑定协议，也不覆盖账号、Project、当前分支、回复版本或用户草稿。记录解析器版本；新聊天无稳定 ID 时不自动绑定；branch／导航改变时使旧许可失效；regenerate 即使不改 conversation ID，也应使依赖旧回复的交接失效。官方 Projects 文档确实描述了分支聊天和项目上下文，因此“同标题／同项目”尤其不能替代 conversation 识别。[Projects in ChatGPT](https://help.openai.com/en/articles/10169521)

## I. Plus Constraint Review

**Q1：不能确认“Plus 当前一定不能用”。官方信息存在直接冲突。**

检索于 2026-09-15；不要用检索时间或搜索引擎爬取时间冒充文档修订时间，也不能据此裁定哪份已取代另一份。

| 产品／套餐 | 当前官方证据 | 对本项目的结论 |
|---|---|---|
| Free | Developer mode 的资格列表未列 Free | 无充分依据认为可用自定义写工具；不等于所有公开 Apps 不可用 |
| Plus | Developer 文档明确列入资格且描述读写；Help Center 完整 MCP 可用范围未列 Plus | 官方口径冲突，必须按当前账号验证；不能标已不可用 |
| Pro | Developer 文档列入；Help Center FAQ 将 Pro 描述为 read/fetch 并限制完整 MCP 范围 | 同样不能保证升级 Pro 即解决 |
| Business | 两份文档均支持完整 MCP 方向 | 仍受管理员／具体账号权限和设置限制 |
| Enterprise | 文档支持，存在管理与 RBAC 限制 | 套餐名不是具体成员已获授权的证明 |
| Edu | 文档支持，存在管理与 RBAC 限制 | 同上 |
| OpenAI Platform API account | 与 ChatGPT 订阅、权限和账单分离 | 不会因此让 ChatGPT Web 获得自定义工具资格，也不保证已获 Tunnel 权限 |

表中套餐差异依据：[Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)、[Help Center：Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。账单边界依据：[ChatGPT vs Platform billing](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform)。

**Verified：** 当前 Browser 个人资料入口显示 Plus。**未验证：** Developer mode 开关、创建自定义 App、当前 Project／Conversation 可选性、实际写工具执行和平台确认行为。查看 Security and login 页面被自动审批审查拒绝；只读授权问题已发出，审查时未获回复，因此没有绕路检查，也没有修改设置。

**Q2：你们对 Tunnel 的核心理解正确。** Secure MCP Tunnel 提供私有 MCP 服务的出站 HTTPS 请求通路；它还有自己的 Platform 权限和组织／工作区关联。官方明确把 Tunnel 权限与 ChatGPT Developer mode 权限分开。它不会授予 ChatGPT 产品资格，不会赋予任意命令权限，也不是休眠聊天唤醒协议。[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

Tunnel 并非自定义 MCP 唯一接入方式，官方还提供公开 HTTPS 端点路径。不能把“此 Tunnel 缺凭据”写成“整条 MCP 架构只有用户提供 API Key 才能继续”。但不应为绕过尚未确认的账号限制，立刻建设公网服务。[Connect from ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)

**Q3：若当前账号／目标模式实际无法调用所需写工具，则 DEFER 这条当前产品路径。** 保留可复用本地 spike，不继续索要 Tunnel/API Key，不要求升级套餐。现在应冻结基础设施扩张，保留一次有界账号核验；若不能核验，就按“不依赖 MCP”推进 Browser 返回实验，同时把 MCP 保留为未决选项。

还要分清项目角色名 Browser Agent 与 ChatGPT 产品的 Agent mode。Help Center 另列模式限制：不能把普通聊天支持 App 推成所有模式支持；目标模式必须单独纳入实测。写操作的确认政策也不等于零确认运行，不能用错误的只读标注逃避审批。[MCP apps FAQ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

## J. Security Gates

**必须现在有：固定 Echo 起采用最小限制；首次真实副作用前落实全部相关边界。**

| 边界 | 最小充分做法 |
|---|---|
| Binding | 固定账号／conversation／IDE session／workspace／repo 快照和 revision；发送前复核，目标变化拒绝 |
| Capability | Echo 只允许固定 echo；真实动作使用允许集合；不提供网页传入任意 shell 的通用入口 |
| 执行权限 | IDE 的实际工具授权／sandbox 与允许能力一致；仅在 Envelope 写 repo path 不足以约束有全盘权限的 IDE |
| 来源与注入 | Envelope 是待授权数据；普通页面文字不能获执行权；严禁把结果中的“请继续／升级权限”直接当控制命令 |
| 本地通道 | 若提供 HTTP/WS：仅 loopback、认证、来源／Host 校验、大小与速率限制；不能把 CORS 当认证；密钥不暴露给页面 MAIN world |
| 重放与重复 | ID 对应不可变内容哈希；同 ID 同内容不重执行，同 ID 不同内容冲突拒绝；期限与 revision 同时校验 |
| 不明投递 | 记录 dispatching；失去确认进入 delivery_unknown；缺接收端幂等时不自动重发 |
| 人工决定 | `blocked(reason, decision_id)` 加暂停闩锁；批准绑定到请求、内容、scope 和 revision；新任务不能借旧批准通行 |
| 并发／取消 | 一次一个在途任务；人类修改方向即停止后续派发；已运行任务另行请求取消，未确认停止就不能宣称取消完成 |
| 超时 | 超时意味着等待期限结束，不证明任务失败／未执行；迟到结果隔离，不能自动复活过期任务 |

浏览器被攻陷时，页面级签名／nonce 也可能被利用。因此 Controller 和 IDE 必须限制最坏情况下的可执行能力；origin 校验主要阻止其他网页，不是受信页面被攻陷后的万能防线。

**以后再加：** 自动恢复与复杂对账、多任务调度、多用户 RBAC、分布式 Controller、完善审计界面、通用 Artifact 系统。连续循环开放之前再落实总轮数／总时长／总成本、无进展停止、重试预算；不能在循环已启用后补这些。

## K. Test / Evidence Gates

不以样本数量判 PASS；每个 Gate 都必须能改变路线选择。测试驱动器／独立记录给出 ground truth，Adapter 不能既发事件又自己宣布通过。

| Gate | 实验与独立证据 | 失败改变什么 |
|---|---|---|
| G0 账号能力 | 当前账号、目标模式和既有 Project 中发现并调用一个无害但按真实写动作政策处理的工具；记录实际确认要求 | 不可用则 MCP DEFER；仅 UI 入口存在保持未决 |
| G1 返回与恢复 | 固定 Result 回到原会话；独立读回已提交消息及 Browser nonce 确认；有草稿／已导航时必须拒绝 | 仅填框成功不能进入 Relay；若只能人工点击则标半自动 |
| G2 IDE 目标与接收 | 独立检查精确 conversation/workspace；分别测活跃、空闲、忙碌及 root/child；接收端可核对 nonce 和执行计数 | HIGH 优先级打断或路由不稳定则增加排队／限制目标，必要时撤销现有会话方案 |
| G3 授权边界 | 错 repo、旧 revision、过期信封、伪造来源、未授权动作、需要人工决定都到不了执行点 | 门禁失败禁止真实任务；修权限边界而不是调 detector |
| G4 不确定副作用 | 在发送前、发送后记账前、结果入库前注入崩溃；丢 ACK；重复 ID／冲突内容；独立计数执行次数 | 没有幂等证据就禁止自动重试；只允许 fail closed／人工对账 |
| G5 人类介入 | 用户草稿、导航、改方向、改工作区、暂停、取消与迟到结果竞态 | 不能保证停止后续派发则不开放循环；不声称能回滚已发生副作用 |
| G6 长任务 | 使用预期真实任务时长及其边界，覆盖浏览器重载、机器睡眠、工具等待失效、断线；证据来自实际恢复和结果关联 | 同步 MCP 不足则 Hybrid／邮箱；若 Browser 无恢复入口则保留人工门禁 |
| G7 真实任务 | 一个受限任务的独立 diff／artifact／验证结果，原 Browser 正确消费同一结果 | Echo PASS 不推广为真实执行 PASS；修结果与权限契约 |

G2 的“忙碌”需要检验业务隔离，而非只证明消息能塞进去。G4 中“零重复执行”只是在已测故障模型下的性质；没有接收端保证，不能宣传 exactly-once。G6 不预设 60 秒就足够，先约定目标任务时长和离线边界。

本轮证据账本：

| 事项 | 等级与结果 |
|---|---|
| 源码冻结与新文档 | Verified：HEAD `6b26f64`，新增两次提交为文档，产品候选仍为 be4f02c |
| agentapi 接口存在 | Verified：本机 CLI help；Documented：官方 Sidecars；未发送消息 |
| metadata／HIGH GUI 注入成功 | Reported：接口报告；本轮未复测 |
| Stop Hook 运行可靠性 | Reported 安装契约；运行时仍未验证 |
| 本地 stdio echo | Verified：原脚本退出 0；500ms 案例约 503ms；缺 nonce 拒绝 |
| 输入 schema 严格性 | Verified 反例：字符串 delay 被接受；严格性 PASS 应撤回 |
| unknown tool | Verified：实际拒绝；原测试自身仍有假阳性漏洞 |
| ChatGPT Plus | Verified：当前浏览器 UI 标签 |
| ChatGPT 写工具／完整 Relay | 未验证；本地 stdio 不构成证据 |
| 当前 detector R1–R6 | 首轮 Verified，证据保留；本轮不重复运行冻结实现 |

本地额外探针输出（仅本地 MCP，不触及 Browser 或 IDE 消息）：

```text
{"input_delay":"0","isError":false,"returned_delay":0}
{"input_delay":-1,"isError":false,"returned_delay":-1}
UNKNOWN_TOOL_REJECTED:MCP error -32603: Unknown tool: unknown.tool.name
```

原服务与测试位于 `/tmp/rally-mcp-spike/server.js`、`test_client.js`；附加探针为 `review-input-check.mjs`。这些是临时实验文件，不应被当成仓库已具备的产品测试套件。

工程自治同样要有明确分工：Agent 完成代码、构建、测试、浏览器操作、证据整理、版本检查和已授权的提交／推送；用户只承担真实授权、不可代替的认证和决策。不要把每次测试 nonce、切 tab、读日志交给用户；也不要借“自治”越过账号授权或把尚未验证的动作写成成功。本轮是独立审查，没有获得向其他会话发送测试消息的明确授权，因此停在只读和本地无害探针，未实施下一阶段实验。

## L. Recommended Next 3 Moves

1. **做一次有界的 Browser 返回／账号能力核验。**
   - 为什么现在：它同时决定 MCP 是否值得继续、现有 Web 会话是否具备返回与恢复路径，风险高于已知的 IDE 注入。
   - PASS：当前账号能力有实证分类；固定 Result 能在原会话真正提交并被 nonce 确认。账号检查受阻时单独标未决，不阻止已获授权的返回实验。
   - FAIL 会改变什么：写工具不可用就 DEFER MCP；返回只能人工触发就明确半自动边界；二者均不可用则停止状态骨架扩建，重新决策 Browser 使用方式。
2. **做一个固定 Echo 的最小完整往返，并只记录它需要的状态。**
   - 为什么现在：把单侧能力连接成真正用户路径，暴露 Envelope 入口、IDE 接收和结果关联的缺口。
   - PASS：一个 Binding、一个在途 Exchange、一个 nonce；原 IDE 接收一次、原 Browser 确认一次，无人工复制；没有下一轮自动派发。
   - FAIL 会改变什么：按断点修改相应 adapter／契约；不恢复通用 SSE detector，也不新建 Dashboard 掩盖问题。
3. **用故障与授权反例守住边界，再放行一个受限真实任务。**
   - 为什么现在：Echo 之后最大的风险是把“连通”升级成“可安全执行”。
   - PASS：错目标／过期／重复／暂停不越界；崩溃后未知即停；真实任务有独立产物证据并返回原会话。
   - FAIL 会改变什么：禁止自动重试和连续循环；若接收端权限无法收窄，则重新考虑执行环境，即使会牺牲“任意既有会话”便利。

## M. Stop Doing

- 停止把 Status Backbone、Inbox 或完整 lifecycle 枚举作为 Echo 往返的前置项目。
- 继续冻结 R1–R6 修复、通知与复杂私有 SSE 分类，直到有明确产品依赖；保留失败证据，不把旧候选恢复为默认 fallback。
- 停止“Plus 一定不支持”和“有官方文档所以当前用户一定支持”两种断言；不建议用户盲目升级 Pro。
- 暂停 Tunnel/API Key 创建与接入扩张；保留一次有界能力核验，不把冻结误解成已经证伪 MCP。
- 停止把 MCP 不可用等同于只能被动推断；显式信封可以换传输，不必放弃授权契约。
- 停止用 Stop、HTTP 200、消息已发送、局部 schema 测试或 Agent 自评作为任务成功和自动续跑证明。
- 停止盲目重试、自动覆盖用户草稿、隐式改绑，以及将 Human Gate、取消和 stale rejection 推迟到连续循环之后。
- 停止为补架构层次再引入一个 AI 协调者；先让确定性 Controller 可靠交付一次有边界的请求与结果。

审查限制：本轮没有改动产品源码、创建凭据、发送测试消息或验证完整闭环。自动审批审查拒绝打开 Security and login，理由是可能暴露私人认证／安全信息，超出其认定的能力核验范围；仅确认 Developer mode 的只读授权仍待用户回复。上述账号能力因此保持未决，不以拒绝本身推断功能不存在。
