# Browser DOM/Tab 路线与下一 Gate 独立审查

日期：2026-09-14。依据：用户本轮提供的 Browser Lead 交接全文、现有仓库研究及本轮核对的 Chrome/Apple 官方文档。本次只做研究，没有实现探针、操作真实页面、改变通知设置或复现运行实验。

## Executive Verdict

**方向已回到正确问题；当前 primary candidate 选择 DOM/Tab。** 暂不选择 Hybrid。新的运行报告足以把普通 ChatGPT 回复的 notification-only 路线降级，不需要为这一决定再投入 DB/Push 研究。DOM/Tab 仍是待验证候选，不是已经成立的可靠 provider。

最短闭环是：**已绑定的真实页面出现可信的 busy-to-quiescent 变化，Rally 保存待查看项并主动提醒，用户点击后回到经重新核对的会话。** 精确会话不可确认时明确失效。成功、质量验收、工作流 gate 不在这个状态的含义中。

对上一轮审查的修正：当时缺具体来源记录，因此建议先查 Browser 通知归因。本轮交接已经补充 iOS 来源及 Chrome 四层零观察的报告，继续以归因实验作为下一前置会造成重复。原报告中的 DB 恢复风险保留为其他来源的背景，不再占本轮关键路径。

## 证据强度：可以采纳什么

| 交接中的证据 | 本次采用的结论 | 仍不能推导 |
| --- | --- | --- |
| 普通回复结束后 Push、Notifications、Chrome 系统通知、DB Chrome 记录均为 0 | 受测 profile/任务模式缺少可依赖的正向通知证据；降级 notification-only 合理 | ChatGPT 所有模式、所有账号永远不发；四个 0 是四次独立实验 |
| Unified Log 为 com.openai.chat / iOS，关闭镜像后通知消失 | 支持当时可见通知来自 iPhone 的来源解释 | 日志里的 record=nil 证明全部镜像通知不会入任何 DB，或 payload 中必定没有会话信息 |
| AI Assistance 报告 Stop generating 等候选元素 | 有值得验证的页面观察假设 | 每个 selector 已覆盖正常/错误/工具阶段；存在稳定公开语义契约 |

以上是用户提供的运行报告，本审查没有取得完整原始日志。四层负观察存在因果依赖，且依赖录制与过滤正确；但我们不需要证明「普遍不可能」才能拒绝把缺乏正向证据的通道设为主入口。

## 真正需要修正的漏洞

### 1. ACTIVE/INACTIVE 同时混进了生成状态与浏览器状态

Chrome 的 tab active 通常指标签页被选中，页面生命周期也使用 active 一词。建议探针记录 `UI_BUSY / UI_QUIESCENT / UNKNOWN`，明确这是当前会话可见 UI 的观察结果。避免让工程日志出现一个没有限定的 ACTIVE。

候选规则应为：先在绑定上下文中观察到 BUSY，之后在同一上下文中观察到稳定 QUIESCENT，且观察没有失效，才生成一次 `ATTENTION`。初次加载就是 idle 不算新事件。观察健康状态与待查看状态分别保存，不能以空闲替代未知。

`aria-label="Stop generating"` 是当前应用给出的文案，可能随语言和版本改变；`.result-streaming` / `.result-thinking` 是私有 CSS 类，并不因名字像语义标签就成为稳定 API。本轮限定实际语言和页面模式，不立即建立覆盖所有布局的大型 selector 库。

### 2. 按钮消失不够；按钮一直不消失也会漏报

导航、重新挂载、阶段切换都会成为消失的候选解释。即使适当 debounce，也不能从时间长度证明任务停止。应一起检查同一 conversation、有效文档、当前 composer 已回到已识别状态；识别冲突或页面不完整时为 UNKNOWN。

反方向也重要：连接失败或网页卡住时，busy UI 可能一直存在，永远没有 busy-to-idle。把 error 包含进 ATTENTION 的弱语义，并没有自动解决这种漏报。长时间无可靠新观测可提示「状态未确认」，不能声称完成。DOM 路线的覆盖范围要由真实失败例决定。

用户主动 Stop 且仍在当前会话时通常无需再次打断用户。采集到变化与弹出提醒是两个决定；本轮可只检验后台提示。待查看项不应因简单聚焦就被认定已经处理。

### 3. tabId 解决运行时定位，不能独自解决会话和轮次身份

官方：tab ID 在浏览器 session 内唯一；`documentId` 标识文档，文档导航会变化；SPA 的 History API 路由变化有独立事件。因此同一个 tab、甚至同一个 document 内都可能更换 ChatGPT conversation。[Tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[WebNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)

最小区分四件事：运行期 tab 句柄、当前文档/观察代次、绑定的 conversation URL、本地观察轮次。不要给每个概念都建服务，但不能共用一个 `tabId`。扩展从可信 `MessageSender` 获取发送 tab/frame/document，不相信网页消息自报的 tab 身份。SPA 路由变化还需单独校验；documentId 不是万能键。[Runtime](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)

本地轮次编号只表示该 observer 看到的一次 busy 周期，不冒充 ChatGPT 服务端 turn ID。

| 情况 | 最小正确行为 |
| --- | --- |
| 同会话两个 tabs | 暂时视为两个观察 endpoint；不能仅凭 URL 宣称两个独立任务或任意合并本地轮次 |
| 页面 reload | 建立新观察代次；旧消息不能覆盖新状态，重载后 idle 不补造完成 |
| tab replacement | 旧句柄失效，核验 replacement 后重新绑定；不靠 tab 的位置猜 |
| tab 移动窗口 | Open 时读取当前所属 windowId，不使用陈旧窗口缓存 |
| 浏览器 restart | 本轮声明不支持连续恢复；旧句柄失效，不能按数字自动恢复 |
| 同 tab 切换 conversation | 终止旧观察链；消失不触发 ATTENTION；旧 Open 不能被报告成成功打开新会话 |
| 新会话尚无稳定 URL | 仅临时 tab-bound；本 Gate 排除。后续仅在同一次可靠观察链中升级绑定 |
| 多 Chrome profiles | 每个 profile 的 extension endpoint 独立作用域；不要假设可全局按 URL 搜索并激活 |
| 同一会话新一轮已经开始 | 旧事件只能保留其旧轮次含义，不能把当前运行状态改成空闲 |

`/c/...` 可作为当前实测路径的候选 conversation key，不应表述成公开、永久稳定的 ChatGPT API。当前 Gate 使用两个已保存、地址已确定的会话即可。

### 4. Open 是明显更直接的能力，但仍需核验目标

扩展可以用 `tabs.update(..., {active:true})` 激活 tab，再让其当前 window 聚焦。这比借用第三方原生通知的私有 callback 直接得多。[Tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Windows](https://developer.chrome.com/docs/extensions/reference/api/windows)

但 Open 前仍需确认 tab 存在、当前 URL/绑定匹配；失败就标 stale，不按标题、最近活跃或相同 URL 的其他 profile 猜。API resolve 不是用户看到了正确会话的全部证据：Gate 要核对实际窗口和页面。检查与激活之间仍可能导航，所以不能声称跨操作原子保证，必要时激活后再次核对。

### 5. DevTools 可能掩盖真实生命周期问题

官方：检查扩展 Service Worker 的 DevTools 会让 worker 保持活跃；MV3 worker 可以终止，状态不能只放在全局变量里。[Chrome 教程](https://developer.chrome.com/docs/extensions/get-started/tutorial/service-worker-events)、[生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

因此正向 Gate 必须在页面与 worker DevTools 关闭时运行，并把证据保存到探针自己的存储而非只看 Console。关闭 DevTools 不等于已经证明 worker 确实休眠；若没有记录实际恢复，只能写「无调试器依赖的运行通过」，不能写「休眠恢复已通过」。

官方：frozen 页面暂停相关 JS，discarded 页面不能继续运行脚本。页面观察失联不是任务停止。[Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

对未知状态正确降级能减少误报，但不提供冻结期间的任务完成覆盖。若产品硬要求关 tab、浏览器退出后仍实时知道结果，纯 DOM 即使完全正确也不满足范围；Network 拦截也不会自动补足浏览器退出后的能力。

### 6. 只输出 AttentionEvent，仍可能把轮询转移到另一个面板

用户正在 IDE 中工作时，事件日志或扩展内部列表可能看不见。下一 Gate 应包含用户可感知的提醒以及点击后路由，不能要求用户不断回 Console 查输出。

最小候选可以由 Rally 扩展发自己的 notification，并把自己的 notification ID 绑定到待查看项。Chrome 提供创建及点击回调；无需读取 ChatGPT 的系统通知。[Chrome Notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)

这是 delivery，不会恢复 notification-only acquisition。仍受系统权限/Focus 等影响；发出 API 成功不能代替实际看见。探针至少保留待查看项，不把提示消失当作事件已处理。跨平台 Inbox、DB bridge、后台 SSE 均不需要因此加入。

### 7. 四个 Agent 的一致意见不是四份独立证据

AI Assistance 官方支持展示执行的代码和返回数据，也会执行可能有副作用的操作；历史会话的上下文不一定自动刷新。[Chrome AI Assistance](https://developer.chrome.com/docs/devtools/ai-assistance/chat)

它可以返回「执行了什么查询、在哪个页面、何时、得到什么」，不能只返回「我判断生成已结束」。Browser Lead 或 Reviewer 应能从记录重建结论。单次发现候选后，让普通探针完成持续观察，不让 AI 坐在每次状态判断链上。

### 8. 从信号候选直接跳到 production extension 仍然过早

DOM/Tab 是能力路线，Chrome Extension 是执行容器。原 README 仍以 Tampermonkey 为原型候选并要求有实际瓶颈再迁移；本轮可以推荐一次性扩展探针来检验真实 tabs/open 能力，但不能把推荐当成生产迁移已批准。

如果已有脚本已能完成同等的身份与 Open，就沿用。Console 手工起两个名字、手工切 tab 的演示则不等价。对于提议中的 MV3 路线，一次性探针通常比同时拼 userscript、localhost 和原生 opener 更容易隔离变量，但这是待实施的实验选择，不是本轮已经证明的成本结论。

## Role Matrix

用户保留产品范围和权限的最终决定；Browser Lead 是被委托的决策整合者。事实由可复核证据决定。IDE Agent 发现反例时应直接挑战假设，不必服从已经过时的架构结论。

| 角色 | Authority | Research / live evidence | Implementation | Review | Production runtime |
| --- | --- | --- | --- | --- | --- |
| Browser Agent | 维护一个 decision record，整合建议并发 Mission | 定义要回答的问题，核对现场记录 | 非主要执行者 | 接受/拒绝 Gate 结果并说明理由 | 否 |
| IDE Agent | 对执行真实性、环境限制负责，可报告反例 | 本地 Chrome/OS/探针的原始证据 | 唯一主要实现与测试执行者 | 检查实现、风险和失败条件 | 否，实际运行的是代码 |
| Chrome AI Assistance | 无独立项目 authority | 可选的临时页面诊断工具 | 本任务只用于诊断，不另起实现任务 | 不担任验收者 | 否 |
| Independent Reviewer（本角色） | 给建议和反证，不维护第二套项目决定 | 官方资料、证据质量、替代路线 | 本轮无 | 独立挑战与 Stop/Pivot 建议 | 否 |

不需要四方依次盖章。最短工作流：一份问题定义 -> IDE 产生可复核记录（必要时借用 DevTools AI）-> Browser Lead 更新同一决策记录；只有新争议才再次请求独立审查。

## 三项明确选择

- **Browser primary candidate：DOM/Tab。** 直接带运行 endpoint，弱 attention 语义可能足够；尚未测通之前，不加入 Network 或 OS 融合补偿。
- **iPhone notification：KEEP_OFF_FOR_NOW。** 保持当前实验条件；不需要为排除 Chrome exact-tab locator 再做一次点击 Gate。
- **AI Assistance：KEEP_AS_TEMP_DIAGNOSTIC。** 保留可用性，不要求持续打开，也不要求每个 Gate 都调用；候选和观察代码已取得后退出运行链。

## iPhone 的八个问题

Apple 明确：镜像通知交互可打开 iPhone Mirroring 内相关 App，手机需要在附近才能进行相应交互；通知接收本身不要求镜像窗口运行或手机在附近。[Apple](https://support.apple.com/en-us/120684)

| 问题 | 当前答案 |
| --- | --- |
| 能作 Attention state switch 吗？ | 只能新增「ChatGPT 有提醒」这一应用级事实；不能修改某个 Browser task 的 working/finished 状态 |
| 点击后去哪？ | Apple 的受支持路径是相关 iPhone App in Mirroring；不承诺 Chrome |
| 能到具体 ChatGPT conversation 吗？ | 取决于 ChatGPT iOS 的通知路由，当前缺独立实测；Apple 文档只保证相关 App 层面 |
| 若能到手机里的具体会话，有价值吗？ | 可能节省知道有事的成本；若下一步必须在 Chrome/IDE 操作，还存在切回成本 |
| 可提取 conversation identity 吗？ | 当前没有证据证明 Rally 可取得。原 App 内部能定位不等于第三方可导出 |
| 是否只是另一 delivery？ | 对当前 Browser provider 是独立来源提示，不能补出 tab 身份；未来有可靠共同键才讨论关联 |
| 会污染测试吗？ | 会增加来源解释成本，尤其只看品牌和文案时；保持关闭最简单 |
| 何时重开？ | 本 Gate 记录完成后，按用户日常偏好恢复，再独立评价 app-level 提示价值；不必等整个产品完成 |

无需宣称「技术上永远不可能从镜像取得身份」。当前缺少证据和收益足以让它退出关键路径。如果用户以后想主要在手机中接续工作，那是产品工作流变化，届时点击实测才有价值。

## Single Next Gate：双会话后台提醒与错误归属对照

**一个 Gate，总时间盒 30 分钟。** 限定一个真实 Chrome profile、同一账号、两个已有稳定 URL 的普通 ChatGPT conversations，最好各在一个普通窗口。不认证浏览器重启、多 profile、关 tab 后实时覆盖或所有任务模式。

如果没有现成可运行探针，不能诚实保证「从零实现 + 全验收」必在 30 分钟完成。下面把准备也计入时间盒；超时记 INCONCLUSIVE，不延长用户反复手测，更不凭空宣布 DOM 失败。

| 时间 | 操作 | 必须留下的证据 |
| --- | --- | --- |
| 0-8 min | IDE 准备/复用一次性探针，绑定 A/B；可用时复用已有工具，否则限定到最小扩展，无 localhost/DB/SSE。校验自身提示输出，随后关闭 DevTools | 明确 endpoint、URL、观察代次，初始 idle 不发 attention；提醒输出可见。准备未完成即结束为 INCONCLUSIVE |
| 8-18 min | A/B 各启动一轮普通回复，探针确认两者 busy 后用户切到 IDE；实际先后顺序按观察记录，不要求模型按指定耗时结束 | 两次真实 busy-to-quiescent，各恰好一个带正确目标的提醒。用户无需查 Console；从两条提醒分别 Open，核对实际窗口/会话 |
| 18-25 min | A 再开始一轮，确认 busy 后在同 tab 切到另一会话；尝试从探针保留的旧 A 项 Open | 导航导致 busy 消失不能生成新 attention，也不能标新会话结束；旧目标不匹配时明确 stale，不声称成功打开 A |
| 25-30 min | IDE 导出一份结果，Browser Lead 按既定标准判定 | 正例结果、负例结果、实际可见提示与实际打开目标；未完成样本和限制全部保留 |

用户工作仅是正常发起少量回复、切到 IDE、点提醒、做一次会话切换。探针装载若必须由用户点一次，只做一次；其余日志收集、汇总和判断由 Agent 完成。本轮无需用户自己整理 DOM/Network 截图。

最小记录：`case, endpoint, document/observerEpoch, boundURL, localRun, before, after, observationValid, attentionEmitted, deliverySeen, openActualTarget`。target 身份取浏览器上下文，不由 AI 从标题猜。判断先看阳性是否真检出，再看误归属是否为零，防止「什么都不输出」也通过。

**PASS**：正例两次都产生可感知提醒并回到正确目标；负例无错误归属，旧目标失效可见；无需持续 DevTools。只允许据此推进限定 DOM 候选的下一阶段，不称为生产可靠性认证。

**FAIL**：明确复现假 attention、串会话、正常结束漏报或 Open 错目标，保存失败层。delivery 被权限挡住不能归为 DOM acquisition 失败；worker 状态丢失先归为探针生命周期问题。

**INCONCLUSIVE**：准备、生成时长、权限或缺证据阻止完成。冻结、worker 真正休眠、多 profile 等没测就写没测，不在此 30 分钟内补全矩阵。

## Stop Criteria

| 决策 | 触发条件与动作 |
| --- | --- |
| STOP_DOM | 正常受支持会话中 UI 信号长期缺失/冲突，或无法在合理复杂度内区分导航与真实 quiescence；停止当前 detector，不靠不断加 selector 掩盖。仅一个 selector 写错或 worker 丢状态不证明 DOM 原理失败 |
| RETURN_TO_NETWORK | 已有可复现的 DOM 语义缺口，且只读网络证据显示存在能解决该具体缺口的字段；提出单字段/单场景研究申请。不能因 tab 定位、通知权限或扩展休眠失败就解冻 SSE，也不自动重开已冻结 Issue #1 |
| KEEP_NOTIFICATION_AS_OPTIONAL_ONLY | 当前普通 Browser 工作没有可靠来源通知；iPhone 没有可供 Rally 使用的会话关联键。应用级提示可独立存在，不改具体 Browser 状态 |
| STOP_BROWSER_PROVIDER_WORK | 用户必须在页面/浏览器关闭后仍有完整实时覆盖，而不接受当前观察范围；或配置、维护和误报成本超过省下的检查。暂停当前本地页面路线并重新选择产品范围/受支持来源，不断言整个问题不可解决 |

## 如何让之后的工作更清楚

每轮只维护一个决策条目：用户要减少的动作、当前唯一候选、已知反例、下一 Gate、PASS/FAIL/INCONCLUSIVE、下一动作。把发现、解释和决定分列。不要因新增工具就新增 owner，也不要把每个边界都升级成新 provider。

本轮最重要的取舍是接受一个诚实的范围：**对仍可观察的已绑定会话，自动提示“现在值得回来看看”，并准确回去；失去观察就明确未知。** 这比同时追求通用通知采集、成功语义、永久身份和跨设备回跳更容易验证。是否足够解决实际痛点，由上述闭环实验决定。
