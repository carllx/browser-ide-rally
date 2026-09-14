# Rally Attention Inbox：Notification + Locator 独立架构审查

审查日期：2026-09-13。只进行了仓库阅读与官方文档核对，没有安装 collector、运行新的 Human Gate、修改或移除 Hook，也没有读取会话正文。

证据口径：**Verified / Human Gate** 指用户明确提供的已验证实验，本次审查没有亲自复现；**Verified / Docs** 指官方接口契约，不代表本机运行通过；**Reported** 指其余用户报告；**Inferred** 指架构判断、假设和建议。下文所有实验方案、门槛与产品判断均为 Inferred。

## 1. Executive Verdict

**Promising but missing a critical capability。** Attention Inbox 的产品方向成立；把 native notification 当作统一入口尚未成立。建议允许不同来源使用不同 provider，暂不承诺 Notification-only。

**Verified / Human Gate：** 同一台 Mac、同一个 Antigravity App、两个不同 conversation、相同任务和相同可见 notification text；分别点击两条通知，进入各自正确 conversation。

**Inferred：** 这证明系统与应用组成的点击路径保留了足以区分目标的上下文。它没有证明上下文位于通知对象中，更没有证明它可导出、可序列化、可转交给 Rally、可重复调用或可跨重启使用。上下文可能依赖应用进程内映射，通知只是一次性索引。

因此应把目标从“永远打开 A”改为可实现的契约：**能定位时准确打开 A；失效或不确定时明确失败，绝不猜成 B。** 会话可能被删除，账号可能退出，任何 locator 都不能保证永远成功。

**Verified / Docs：** Apple `UNUserNotificationCenter` 管理调用方 app/extension 的通知；其 delegate 接收自身通知响应。这不是公开的第三方通知订阅及 activation 接管接口。本次没有找到满足 Rally 两项要求的受支持 macOS 全局 API；这不等于证明所有可能路径都不存在。[Apple UserNotifications](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter)

**Reported：** ChatGPT Browser 可以产生后台系统通知；Hook 提供了实验所需元数据。Browser 精确路由、Mac 程序化捕获、locator 生命周期和 Windows runtime 均未验证。

## 2. Rebuild Our Next Steps：最多五步

1. **固定证据和基线。** 保存现有 Human Gate 的条件、A/B 对照、软件版本及已有证据引用；缺少的资料标记未记录。保留诊断脚本和撤销说明，日常禁用临时 Hook。先记录当前 Notification Center 在同样工作负载下已经减少多少轮询，作为 Rally 的比较基线。
2. **做一次有时间盒的 Mac activation 实验。** 在两个同文通知上，尝试取得两个可区分的 AX 元素/操作句柄，由一个最小本地列表代为触发；再测通知中心关闭重开、重排和延迟。先证明 Rally 能代点，别先造通用 collector 或 Dashboard。建议投入上限一个工作日；这是预算建议，不是工时预测。
3. **按第二步结果选择下一来源。** Mac 成功则补自动捕获及失效检测；失败则停止将 Mac collector 设为 MVP 前置。Browser 做双 conversation 碰撞测试，同时核验当前会话 URL 与 tab 的独立导航能力。Windows 只有在真实 Windows 设备上独立通过 capture 与 activation 两道门，才能进入候选。
4. **用一个通过的 provider 做真实小型试用。** 两到三个并行会话、真实自动 attention、准确 Open、最小标签、显式“已处理”、stale 状态即可。比较无效查看次数、寻找目标耗时、漏报、误跳及绑定维护时间。匿名列表先测，标签可人工补，不等自动 enrichment。
5. **只扩展通过的能力。** 若单来源确实省时，再加另一 provider 和恢复能力；跨设备、中继、复杂优先级继续后置。若原生通知中心已一样好用，停止复制 Inbox，转做原生体验缺失的标签、持久待处理或已绑定目标导航。

## 3. Current Vulnerabilities：五个可能使路线失败的漏洞

1. **能力不可转交。** 系统能点击不意味着 Rally 能取得调用权；读到标题甚至 payload，也不意味着拥有原应用回调执行上下文。
2. **瞬态句柄冒充持久地址。** 通知消失、进程退出或 UI 重建后失效；重用位置、标题或旧 ID 可能打开另一条同文通知。
3. **通知覆盖率不足。** 用户需要注意的审批、错误、等待输入或完成未必都有通知；前台策略和免打扰也需测。ATTENTION 放宽语义，但不能解决没有事件的问题。
4. **人为绑定没有解决事件归属。** A/B 各有正确 URL，并不能把两个无身份通知分配到 A/B。按最近活跃、到达顺序或最近 Hook 时间配对，在并发下仍会串线。
5. **新 Inbox 复制旧负担。** 三行匿名 Antigravity 虽能减少寻找，却仍需逐个打开才知道谁值得看；若另加维护、清理和权限负担，可能比原生中心更慢。

## 4. New Possibilities

| 方案 | 最低成本验证 | 限制 |
| --- | --- | --- |
| **原通知动作代理（notification action proxy）** | Rally 保留指向现存原通知 UI 的引用，在用户 Open 时调用其公开 AX action | 复用原有路由，不必理解 conversationId；依赖原对象存活，不等于导出 payload |
| **显式绑定 endpoint 的快捷队列** | 人工一次命名并绑定 A/B 的 URL 或已证明可恢复的目标；先测导航收益 | 只解决导航和识别；自动 attention 仍需来自 endpoint 的可归属信号 |
| **Browser 源头 provider** | 从已绑定页面获取会话地址，并在页面/同源通知层验证最小 attention 信号 | 无需 OS collector 或 SSE parser；页面通知与 worker 通知不能混为一谈 |
| **应用支持的“复制会话链接 / 打开会话”接口** | 仅检查真实应用公开命令、菜单和文档；若存在，保存并在切换会话及重启后打开 | Antigravity 是否存在适用接口尚未验证；conversationId 或注册 URL scheme 单独都不构成 opener |
| **保留原生通知中心，只补缺项** | 对比系统中心与轻量列表，测用户是否仅需要标签、待处理保留或绑定目标快捷键 | 若无需新列表就达到目标，停止 Inbox 工程是合理结果 |

**Inferred：** 第一种可以称为 action proxy；若 provider 真正授予可调用的对象引用，也可以用 capability handle 描述它。后者是设计术语，不是已发现的 macOS 系统机制。文本通知转发器只有在明确实现原动作代理时才有帮助；转发文本、复制 payload 或新建一条通知不会自动继承原回调。

**Verified / Docs：** Hammerspoon 能枚举 AX 元素支持的 actions 并请求执行，但能力取决于应用实际暴露内容；文档中的 Notification Center window-filter 示例只支持把它列入实验候选。[AX 文档](https://www.hammerspoon.org/docs/hs.axuielement.html)、[window filter](https://www.hammerspoon.org/docs/hs.window.filter.html)

**Inferred：** Hammerspoon、Shortcuts、Raycast、BetterTouchTool 是可能承载实验或 UI 的工具，不能因工具存在就推断拥有全局通知权限。event taps 记录输入也不自然产生通知到会话的映射，不值得先走。

## 5. Biggest Blind Spots

| 盲区 | 早期必须回答的问题或处理方式 |
| --- | --- |
| Locator lifecycle / stale | 即时、60 分钟、通知被删除、collector/目标 app 重启后还能否准确打开？各条件用新通知独立测试，避免第一次点击消耗对象干扰结论 |
| 相同通知与重排 | 插入第三条、展开/折叠分组、A/B 完成顺序交换后，原引用是否仍指向原实例？不以列表下标、坐标或正文作身份 |
| Duplicate / update | 同一通知更新和新一次 attention 如何区分？保留 provider 的实例/修订信息；无可靠证据不按同文合并 |
| Sleep / wake / 离线 | 丢失的事件是否可重新枚举？恢复后先重同步，无法证明覆盖完整时标记 Unknown，不能把空列表解释为“没事” |
| OS 权限 / sandbox | 通知显示权限、第三方读取、AX 控制、自动化权限分别核验；授权撤销与真正零通知必须可区分；开发脚本成功不代表打包 sandbox 内成功 |
| Browser Tab routing | 精确 conversation 与原 tab 是不同承诺；tab 可换 URL、关闭、重复打开。同一 URL 也可能存在多个 profile/account 上下文 |
| 跨设备 | 本机句柄不能默认在另一台机器运行；将来需把 Open 请求路由回来源设备，并处理离线。MVP 不实现这套远程控制 |
| Privacy | 只允许目标来源，尽早过滤，不保存全局通知正文、AX 树或未知 payload；opaque 字段也可能含敏感 token，日志仅用本地引用 |
| Accessibility | AX API 公开不等于目标 UI 层级稳定。Inbox 自身还应支持键盘使用，不依赖自动抢焦点；Open 由用户触发 |
| Attention 生命周期 | 原通知移除不等于已处理；Open 成功也不等于已阅读。旧运行的 attention 不应被新运行误用；早期必须能显式清理 |

**Inferred：** Locator 生命周期是核心隐藏风险之一，但排在“能否取得并调用”之后。另一个同样重要的风险是通知漏报：一个能精准打开、却经常漏掉需要注意的任务的队列，仍不能减少用户轮询。

## 6. Hook Review

**选择：retain only as diagnostic tool；日常禁用，保留可复现实验能力。** 不建议以彻底删除诊断工具作为成功标志，也不主张现在直接升级为生产 primary provider。

**Verified / Docs：** Antigravity 官方 Hook 文档列出 `conversationId`、`workspacePaths`；Stop 包含 `executionNum`、`terminationReason`、`fullyIdle`，且输出能改变继续执行行为。诊断必须刻意保持观察用途。[Antigravity Hooks](https://antigravity.google/docs/hooks/)

**Inferred：** “Hook 不是 Notification Collector”这个分类正确；“所以 Hook 不应成为 Attention provider”并不成立。应比较端到端成本，不能为了去掉一个受支持 Hook，换成权限更广、维护更难的 AX 抓取。

若 Notification 不能可靠归属，而 Hook 事件能直接归属已绑定 endpoint，允许 Hook 成为 IDE 的主要 attention 来源，比“通知 + Hook 按时间猜配”更清晰。它仍然缺一个已验证的精确 opener；conversationId 本身不是可执行导航地址。

只有两来源拥有可靠关联键时，才用 Hook 做 identity enrichment。诊断时也不能将“最近一次 Stop”直接视为同文通知的 ground truth；ground truth 必须来自点击后实际会话与独立 ID 核验。用户给定的 Human Gate 结论保持成立。

## 7. Notification + Locator Architecture Review

**Inferred：有条件足够，但核心对象应为 attention item + provider-owned open target。** Notification 是一种来源，不必写死为领域对象名称。Opaque locator 不承担完整 conversation identity 职责；两个 locator 可以指向同一会话，同一个会话也可以多次产生 attention。

最小概念 schema，非要求现在实现的框架：

```typescript
type AttentionItem = {
  id: string;                    // Rally attention 实例，持久且独立于通知 ID
  source: {
    provider: string;
    deviceId: string;
    scopeId: string;              // provider 安装/账号/profile 的本地作用域
    eventKey?: string;            // 只有来源保证可靠时用于去重
  };
  observedAt: string;
  kind: "attention";
  label?: string;                 // 可人工提供；不作为身份凭证
  status: "pending" | "acknowledged";
  target: null | {
    ref: string;                  // 本地 provider 引用，不把任意 payload 当命令
    lifetime: "notification" | "session" | "persistent" | "unknown";
    state: "unverified" | "ready" | "stale";
  };
};
```

Provider 暴露一个小接口：`open(ref)` 返回 `opened | stale | unavailable | ambiguous`。`opened` 的验收依据必须包含已验证的目标路由；仅“系统接受了 AX 请求”不能冒充已到达正确会话。没有事后核验能力时，UI 最多显示已发出打开请求。

契约比字段更重要：

- 目标不存在或含糊时停下，不按标题重新猜配；不自动退到当前 conversation。
- Inbox 留存与 OS 通知留存分开。通知消失后仍保存 pending item，target 失效则展示“目标已失效 / 重新绑定”，不能无条件保留可用 Open。
- 不保存内存 AX 指针为持久 locator。collector 重启后，在没有可证明重绑定办法时将它置为 stale。
- 去重区分 attention 实例、通知实例与 endpoint；不要用标题、时间戳或 conversationId 单独充当事件 ID。
- 默认本机运行；`deviceId` 是作用域信息，并不授权或实现跨设备执行。

**Inferred：** 无项目标签也能验证“减少寻找”的价值，但不能证明“帮助排序”的价值。第一版可以接受匿名项；一旦用户仍需逐个打开辨认，就加入人工短标签。显式“已处理”和 stale 状态应从 Step 5 提前到 MVP，复杂 snooze 可以后置。

## 8. Browser Strategy

**Inferred：** 不应从 Antigravity 的通过结果推断 Browser 路由。下一次 Browser 实验应有两个验收层：

1. **Human Gate：** 同一浏览器/profile 内 A/B 执行相同任务，确保已进入可触发通知的后台状态。记录原 tab ID（若可得）、窗口和会话 URL，核对通知数量、可见文字及每次点击后的 URL/会话。区分回原 tab、回正确会话的新 tab、只激活浏览器三种结果。同任务不保证 Browser 实际通知同文，按实测记录。
2. **Programmatic Gate：** 测同源页面的 `ServiceWorkerRegistration.getNotifications()` 是否能读到这些通知，以及允许读取的最小字段是否含可验证的目标信息；如果走页面 `Notification` 路径，则单独验证该路径。取得对象或 data 不代表能调用原点击回调，不用合成 click 冒充系统激活。

**Verified / Docs：** `getNotifications()` 受 origin 与 service-worker registration 限制；它不提供通用原生点击重放接口。Chrome 扩展 `notifications.getAll()` 只枚举自己的通知。[Notifications 标准](https://notifications.spec.whatwg.org/#dom-serviceworkerregistration-getnotifications)、[Chrome notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications#method-getAll)

**Inferred：** 若通知层拿不到可用关联，Browser provider 仍可独立组合“已绑定 tab 的最小 DOM attention 信号 + 当前 conversation URL”。这不是完成证明，需测误报和漏报；不必立即恢复 Network。

**Verified / Docs：** Chrome tabs 接口提供查询与 tab 操作，tab ID 只保证在浏览器 session 内唯一。[Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)

**Inferred：** Open 前校验原 tab 仍对应绑定会话；若已换页，不得直接聚焦旧 tab。存在可靠的会话 URL 时，可按明确策略在正确 profile 新开该会话；仅保证 conversation，不保证原 tab。临时对话、无稳定 URL 或账号不符时应 stale。无需为了读当前 URL 先引入扩展；只有实际 tab 操作或信号需求超过现有轻量方案时再升级。

## 9. Mac Strategy：三个按优先级排序的实验

**第一：现存原通知的 AX 动作代理。** 复用已有 automation host（若存在），否则用最小可撤销探针。只枚举目标通知必要属性与 actions，查找两个可独立持有的实例；不假设一定有 `AXPress`，不以屏幕坐标、正文或顺序选目标。测试由本地两项列表触发原动作，关闭重开通知中心并重排后再次验证，最后进入独立生命周期样本。

通过条件：A/B 可程序化区分并准确调用；缺失时明确失败。此处成功只证明 live action proxy，不等于后台完整采集或持久 locator。需要用户原生授予 Accessibility 权限；公开 AX API 不保证 Notification Center 当前版本暴露稳定结构。[Hammerspoon AX](https://www.hammerspoon.org/docs/hs.axuielement.html)

**第二：应用提供 locator，绕过通知中心。** 检查真实 Antigravity 是否提供受支持的复制会话链接、打开指定会话命令或可用于精确恢复的接口；若存在，对 A/B 保存地址并独立重开。Browser 直接用当前会话地址作比较。只有 app/window 焦点能力则判定未通过 exact conversation，不继续包装成 deep link。

**Verified / Docs：** `NSUserActivity` 用于应用提供及恢复自身活动；`NSWorkspace` 可打开 URL/应用。这些接口不构成读取其他应用任意 notification routing state 的保证。[NSUserActivity](https://developer.apple.com/documentation/foundation/nsuseractivity)、[App activation](https://developer.apple.com/documentation/appkit/passing-control-from-one-app-to-another-with-cooperative-activation)

**第三：来源拥有 identity 的本地 provider。** 若前两条无可用方案，复用临时 Stop Hook，仅发白名单 metadata 到本地，并尝试与已验证 endpoint binding 组成闭环；Browser 使用自己页面的 provider。这个实验明确是绕过全局 acquisition，不能声称成功捕获原通知。IDE 若仍无精确 opener，则保留 app/workspace 级提示或暂停该来源，不能降低用户的 exact conversation 要求。

不优先 private database、进程注入或大 native App。它们没有被证明能以更低成本补齐当前能力缺口。

## 10. Stop / Pivot Criteria

以下为建议的实验决策门槛，不是统计可靠性证明：基础 A/B 碰撞至少重复五组且无串目标，再通过 UI 重排、60 分钟延迟和失效检测。样本通过后才扩大覆盖，不据此宣称生产稳定。

| 路线 | 停止或转向条件 |
| --- | --- |
| Notification-only | 在目标工作负载漏掉重要 attention，或取得通知但无可靠目标归属；转为来源 provider。匿名通知不得硬配 endpoint |
| Native locator | 无可取得/调用句柄；发生错误目标且无法可靠检测；或寿命短于实际处理间隔且无法恢复。可保留 live-only 辅助，但退出持久 Inbox 的唯一 opener |
| Hook | 不能保持只读观察、影响正常执行、版本支持不符，或对信号/归属没有增益时停用。若比 AX 更简单可靠，可升级 IDE provider，勿为消除依赖而消除它 |
| Browser Network | 当前保持冻结。只有非 Network 路径已失败、明确缺少哪个最小字段，且已有证据表明 Network 能补齐时才恢复；若需完整 response、通用状态机或持续私有协议维护，停止本轮 MVP 投入 |
| macOS collector | 一个工作日的受限探针仍不能同时获取可区分实例并调用原动作，或只能依赖同文坐标/顺序猜测，停止作为核心路线；记录条件后转 Browser 或 supported IDE provider |

**Verified / Docs：** Windows `UserNotificationListener` 能读取其他应用通知，需要 manifest capability 与用户授权；返回对象公开的是 app、ID、时间与 visual 内容。公开 listener 方法没有通用“激活原 toast”，其 `Notification` 类型不能混同发送方 `ToastNotification.Content` 的 XML。[Listener guide](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)、[Listener API](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.management.usernotificationlistener)、[Notification API](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.notification)

**Inferred：** Windows 仍需单独做程序化 capture + Open 实验；官方 listener 让 capture 更有依据，并未让 locator 自动成立。Mac 成功也不外推到 Windows。

## 11. Final Recommendation：只选一个实验

**选择“Mac 两条同文 Antigravity 通知的程序化代点与延迟失效实验”。**

沿用已通过的 Human Gate 条件，创建独立 A/B 样本。最小本地列表保存各自 AX 引用，让测试者从该列表执行 Open；独立记录预期会话和实际结果，并交换执行顺序。先验证即时调用；通过后以新样本分别测试通知中心关闭重开/重排、60 分钟等待，以及原通知删除后的明确失败。不要在已经点击并消耗的同一通知上假装完成延迟测试。

记录最小结果表：`sample / expected target / observed target / handle type / elapsed / notification present / result`，不读取响应正文。即使 AX 返回成功，也要由实际进入会话的结果验收。若无法区分两个实例或拿不到 action，立即记录失败，不扩大到私有数据库研究。

这个实验复用已验证的 app 原生路由，专门检验唯一关键新增假设：**那份路由能力能否被 Rally 借用。** 通过才补自动采集；失败就把 Attention Inbox 留下来，把 Notification Center 从必经路径上移走。

与现有仓库资料的关系：README 仍描述 1:1 binding 优先及旧传输假设；本报告依据用户最新要求建议调整 MVP 优先级，不改其故障隔离和禁止任意命令执行原则。现有 `docs/research/*review.md` 保持原样；本报告没有实施架构迁移。
