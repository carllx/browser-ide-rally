# Rally Attention Acquisition 独立架构审查

研究日：2026-09-14。角色：Independent Architecture Reviewer / Red-Team Researcher。只做研究，没有实现或运行 collector，没有读取私人通知数据库，没有改变浏览器、Hook、系统权限或通知设置。

## 判断与证据边界

**目前不支持把 DB + Source Enrichment 定为目标架构。** 它是值得保留的候选，但应先与来源直接信号、原生产品功能比较端到端效果。核心缺口是「真实任务需要关注时，用户是否及时知道」，不是「已经有通知时，能否再收集一次」。以下优先级指架构风险，不是已复现的代码缺陷。

本次依据用户明确的目标及仓库现有研究。用户消息没有附具体运行日志；仓库里没有当前 collector 源码。GitHub Issue 读取先遇到网络限制，放行后的只读重试返回 HTTP 401，因此未取得最新 Issue 证据。没有把旧研究的 Verified 标签升级成本次复现结果。

| 已有材料 | 本次能采用的证据 | 不能据此确认的事 |
| --- | --- | --- |
| [既有 locator 审查](./notification-locator-red-team-review.md)，第 11 行 | 报告称 Antigravity 两个会话的同文通知能分别点击回正确会话 | Rally 可捕获、转交或持久重放该动作 |
| 同文档，第 19 行 | 报告称 ChatGPT Browser 能产生后台通知 | 实际生产者是 Chrome、Mac App 还是 iPhone；普通回复与特殊后台任务是否同机制 |
| [统一 DB 研究](./macos-unified-notification-monitoring.md)，第 19 行 | 报告只运行了 OS 版本检查，未做真实 DB capture | 本机路径、权限、schema、端到端覆盖已通过 |
| 同文档，第 23 行 | 记录有 STOP_NATIVE_LOCATOR / STOP_ANTIGRAVITY_EXACT_OPENER | 缺少原始失败记录，不能独立判断失败的具体边界 |

在线资料是本研究日抓取的动态页面，不是对旧实验日期的历史快照。下文「官方」表示接口或文档事实；「推论」表示本次判断；「待测」表示对目标账号、版本和设备尚未确认。

## 按影响排序的发现

### 1. P1：采集验收分母正确，但被用于回答了错误的产品问题

[DB 研究第 352 行](./macos-unified-notification-monitoring.md)以「正常后台且实际发出通知」的 6 个 IDE + 3 个 Browser 样本全捕获为门槛。这适合检验 reader，不能检验减少人工轮询的能力。假设 100 次需要关注的状态只产生 10 条通知，10/10 捕获仍只覆盖 10/100。

推论：必须同时报告真实 attention 的覆盖率和已发通知的采集率。不能看到缺通知就把该样本排除，也不能仅凭没 banner 就认定生产者没有发送。没有独立发射证据时，故障层应记 unknown。

即使 9/9 成功，在独立同分布的理想假设下，成功概率的一侧 95% 精确下界也只有约 0.717（0.05^(1/9)）；同设备同会话的样本通常还存在相关性。这不是要求扩大一次探针，而是禁止把探针通过解释成高可靠性。

### 2. P1：把 app-level attention 当作成功，可能悄悄缩小了原目标

[DB 研究第 7 行](./macos-unified-notification-monitoring.md)允许「Antigravity 有 2 条新通知」作为第一阶段结果。它可能减少检查频率，值得测；但如果用户仍需逐个打开 A/B 才知道哪个需要处理，任务归属问题仍在。

应分别测「多久知道有事」与「多久找到应该处理的会话」。不需要一开始解决原通知 action replay，但也不能以 capture 通过宣布免轮询问题已解决。已有报告早已提醒身份与 locator 分离；本次挑战的是放宽验收后是否还有足够的用户收益。

### 3. P1：iPhone Mirroring 是遗漏的来源混杂变量

官方：首次连接之后，即使 iPhone Mirroring 未运行、手机不在附近，Mac 仍可接收 iPhone 通知；通知带 iPhone badge，手机清除会同步影响 Mac，点击可以进入镜像内的 App。安装对应 Mac App 也影响来源选择。[Apple](https://support.apple.com/en-us/120684)

推论：看到 ChatGPT 品牌、关闭浏览器仍有通知、点击回到某个对话，都不足以证明 Chrome Web Push。退出 Mirroring 窗口不是有效的关闭对照。实验必须记录并独立控制「Allow notifications from iPhone」、Mac App、Chrome profile，以及通知实际打开的应用。

这没有证明此前报告误认了来源，只证明其现有记录不足以排除混杂。镜像链本身也不是自动更可靠的替代：它增加设备和转发条件，本次没有验证其 DB 字段。

### 4. P1：Browser 的多个处理层被容易地混为同一条信号

应把可能路径展开，而不是先假定所有 ChatGPT 后台工作都走同一路线：

```text
任务需要关注
  -> 产品决定是否通知
  -> 页面本地通知，或服务器推送到浏览器，或手机/Mac App 通知
  -> 浏览器/系统生成并保留通知
  -> Rally 观察到
  -> 用户获知并找到目标
```

官方：Push 可以激活相应 Service Worker；订阅可能刷新、失效或因权限撤销被停用。通知权限获批不等于订阅有效，更不等于服务端已为每个任务类别发送。[Push API](https://w3c.github.io/push-api/)

官方：`getNotifications()` 查询特定 registration 的通知集合；它不是历史审计流。页面 `Notification` 和 Service Worker 的持久通知有不同作用域。[Notifications Standard](https://notifications.spec.whatwg.org/#dom-serviceworkerregistration-getnotifications)

推论：包装页面的 `window.Notification` 或 `fetch` 没看到事件，不能推出没有 worker 通知；`getNotifications()` 空数组也可能是查错 registration、通知已关闭或使用了另一条路径。只检查当前 controller 会遗漏需要核实的 registration 范围。同样，不应把最新标准中存在的路径直接当成当前 Chrome/ChatGPT 已采用。

### 5. P1：更短的诊断路径已经存在，应先于新 collector

官方：Chrome DevTools 的 Application > Background services 可分别记录 Notifications 和 Push Messaging，开启后可关闭 DevTools继续记录，最长三天。[Chrome 文档](https://developer.chrome.com/docs/devtools/javascript/background-services)

推论：在实际登录 profile 先录这两类事件，并用正常产品操作触发真实任务。Push 记录、Notification 记录、系统呈现和 DB 查询结果分开记录，便于确定失败层。日志缺项只有在确认录制生效、作用域正确且有对照后才有解释力。

DevTools 的模拟 Push、手写 `showNotification()` 仅测试局部管道，不能证明 ChatGPT 服务端会为真实工作发送。诊断录制也不是生产采集 API，没有理由立刻把 CDP 变为常驻依赖。

官方：Chrome 136 起，传统 `--remote-debugging-port` / `--remote-debugging-pipe` 对默认数据目录受限制，需要非默认 `--user-data-dir`。[Chrome 调试变更](https://developer.chrome.com/blog/remote-debugging-port)

因此「新建调试 profile 一测就知道日常 Chrome 行为」存在偏差：账号、权限、订阅与安装状态都可能不同。该限制针对这些启动参数，不等于所有已有浏览器连接方式一律不可用。

### 6. P1：SQLite 一致快照不是每个 attention 的事件日志

官方：SQLite 读事务观察已提交快照；它没有为另一个只读连接提供完整变更历史。[SQLite Isolation](https://www.sqlite.org/isolation.html)

推论：两次 SELECT 之间先插入再删除的通知可能完全不可见；A->B->C 更新可能只看到 C。即使 reader 一直在线、WAL watcher 正常、每次查询都一致，中间状态仍可能丢失。这比旧报告已经承认的「停机期间被清除无法补回」更强。

如果只需要「这个应用自上次处理后有变化」，丢掉部分中间状态可能可接受；如果需要每次运行的准确计数，则快照没有足够契约。不要为弥补此缺口继续构建系统 WAL 取证解析器。一致读取、及时读取、完整事件历史是三项不同能力。

### 7. P1：启动 baseline 建议与恢复目标冲突

[DB 研究第 263、322 行](./macos-unified-notification-monitoring.md)建议启动先建立 baseline，并在内存记录现有身份。用于首次实验是合理的；如果推广成每次重启策略，停机期间的新通知会被当成历史跳过。

同文档的「队列写成功后推进游标」避免了先推进导致的漏读，但仍有写队列后崩溃、游标未保存导致的重复窗口。生产需要明确首次安装、正常恢复、连续性不可确认三种情形，以及本地事务或幂等键。提出 database generation 这个名字，不等于已经有可靠的 generation 判定方法。

这是设计缺口，非已找到实现 bug。最小反例：reader 停止时产生通知，再启动，应恢复一次；另在入队与保存进度之间中断，检查是否重复。

### 8. P1：来源信号足够好时，DB enrichment 反而增加依赖

官方：Antigravity Stop 包含 `conversationId`、`executionNum`、`terminationReason`、`fullyIdle`。Stop 表示执行循环结束；原因可能是正常停止、错误或超步数，`fullyIdle=false` 表示还有后台工作。Hook 输出还可以改变执行流程。[Antigravity Hooks](https://antigravity.google/docs/hooks/)

推论：应把受支持 Hook 作为直接来源候选独立比较。若已有准确来源事件，再经过 OS 通知、DB、跨源关联，只会增加环节，除非实测证明 DB 带来额外覆盖。Stop 不可统一翻译成「任务成功完成」，`fullyIdle=true` 也不等于工作质量验收通过。

同样，未知是否发第二次 Stop 的情况下，不能只丢弃 `fullyIdle=false` 然后假设最终一定有 true。此点需目标版本实测。观察 Hook 必须失败不阻断正常运行，不能照抄文档的 continue 示例。

已有报告已经提出 Hook 可当 provider。本次进一步建议：去掉「必须先经 DB」的优先级，按每个来源实际证据选择主路径。精确 IDE opener 仍是独立待测能力。

### 9. P2：网页观察可以更短，但失联不能解释为完成

官方：Chrome 的 frozen 页面会暂停相关 JS timer 和 fetch callback；页面也可能被 discard，且 discard 不发页面事件。[Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

推论：若做已绑定页面的最小 DOM 状态观察，必须把 tab/profile/conversation/run 分开，并在导航、刷新、失联后标 unknown。停止按钮消失可能是导航、错误、重新挂载，不是完成；传输结束可能是断线，不是成功。后台 heartbeat 丢失只能说明观察失去新鲜度。

测试应含已完成 A 后立即开始 A 的下一轮、重复打开同会话、旧消息仍显示、切换账号、后台冻结和恢复。不需现在构造复杂通用状态机，但必须阻止「上一轮事件覆盖当前轮」这种最小错误。

### 10. P2：独立记录数、提醒数、任务数不能共用一个身份

官方：普通 SQLite INTEGER PRIMARY KEY/ROWID 在条件允许时可复用；是否使用 AUTOINCREMENT 要看实际 DDL。[SQLite](https://www.sqlite.org/autoinc.html)

推论：database generation 不能自动解决同一数据库内的 ID 复用；不同 UUID 也不证明不同任务。一个任务可多次提醒，同一个任务可经手机与浏览器分别提醒，两任务也可同文。已有报告正确反对按正文去重，本次补充的是：不要让「有两个来源实例」偷偷变成「有两个完成的任务」。

没有可靠共享键就保持独立来源，避免时间近邻关联。若产品只需应用级提醒，可以主动合并为一项待查看状态，不必先解决全局精确去重。

### 11. P2：现有原生功能可能已覆盖相当一部分目标

官方当前 Notifications 文档描述 Activity view：在可用的界面中列出 unread、running、waiting for response 的 chats；桌面通知有完成、权限与问题控制，Web 的类别和渠道随账号而变。[OpenAI Docs](https://learn.chatgpt.com/docs/notifications)

官方还区分 hosted Web work 与需要本地环境保持可用的工作。[Long-running work](https://learn.chatgpt.com/docs/long-running-work)

推论：应先检查用户实际账号是否已有对应 Activity/通知能力，测它能减少多少检查。不能假定用户已具备该功能，也不能从桌面通知或 Scheduled Tasks 文档推断普通 Web 回复必有通知。把日常会话改成 Tasks、API 或另一客户端会改变工作方式，只有用户接受该变化时才是替代路径。

Rally 的必要性应由原生功能之后仍存在的跨产品缺口决定，例如 IDE 聚合、可靠持久待处理和目标识别。否则可能花大量工程成本复制已存在的视图。

### 12. P2：健康的 collector 仍可能给出错误的安心感

旧报告已要求权限/schema/解析失败不能显示「暂无新消息」，这是必要的。进一步的盲区是：DB 可读且查询成功，并不能证明某个 ChatGPT 任务类别或 Chrome profile 的上游通知仍有效。

推论：至少区分采集进程健康、来源最近验证时间、任务状态新鲜度。不需要复杂监控平台，但「没有观察到」不能渲染成「所有任务仍在运行」。通知消失或用户聚焦也不自动表示已处理；由下一轮活动或明确确认消除待处理状态时，应防止迟到的旧事件重新点亮。

## 对已有开源与系统研究的纠偏

既有报告已具体指出 Notiful 逐文件复制、WeChat reader 有限窗口、anotifier marker/行数限制。这些是有价值的审查，不应再次包装成新发现。本次未重新拉取这些项目的固定版本，保留为旧报告的源码核验记录。

不能以这些工具的「若干秒后读到」直接测得 macOS commit latency，观察结果混合发送、扫描、copy、过滤和解析延迟。官方 SQLite Backup API 能协调一致副本，但它不是完整事件重放机制。[SQLite Backup](https://www.sqlite.org/backup.html)

同样，不应因系统数据库未公开就声称只读采集必然损坏系统，也不应因公开 AX 访问一次失败就声称所有可见 banner 都不可观察。当前证据足以限制承诺，不足以证明某一路线普遍不可能。原先停止的 native locator 实验不因本次研究自动重开。

## 更短路线的选择

| 路线 | 先证明什么 | 适用条件与限制 |
| --- | --- | --- |
| 原生 Activity/通知 + 最小人工整理 | 在实际账号和工作负载下减少检查 | 零新增 collector；未必跨 IDE，也未必持久 |
| IDE 官方 Hook -> 简单本地待处理状态 | 正常停止、错误、后台仍忙的语义与身份 | 不保证任务成功或精确 opener；故障不能影响 Agent |
| Browser 已绑定页面 -> 最小 attention 观察 | 当前真实会话和轮次可辨，后台误报/漏报可接受 | 保留 unknown；冻结/关闭后的覆盖有限 |
| Browser 已验证持久通知路径 | registration、来源与实际产品通知一致 | 更接近现成通知，但没有完整历史保证 |
| macOS DB -> 应用级补充提示 | 捕获来源直接路径漏掉的有用事件 | FDA、私有 schema、短暂记录和恢复成本 |

推荐顺序是比较实际收益，而非固定技术阶梯。DB 只有显示出独立增益才升级为主要 provider；Browser 与 IDE 无需使用同一种采集机制。也不要求先造统一 Inbox，最小持久待处理列表就能测价值。

## 下一次实验应回答的五个问题

以下是待做实验方案，本次没有执行。先做顺序实验，按发现扩展，不做所有因素的笛卡尔积。

1. **到底哪些工作需要提醒？** 预先登记普通回复、长任务、等待输入、错误与用户停止，保存独立 case/run 标识。以最终实际状态作为覆盖分母，不以通知作为分母。操作者不要只记录出现通知的成功案例。
2. **提醒由谁产生？** 在实际 profile 做 browser-only 对照，单独控制 iPhone/Mac App 通知。记录 DevTools Push/Notifications，随后核对系统来源及实际点击目标。用合成通知校准观测器，但不计入产品覆盖样本。
3. **并发是否串线？** A/B 同时运行、反向结束；同文与不同文都测；加入 A 下一轮先开始、上一轮通知迟到、同会话双 tab。先保留可区分的独立真值，再测同文碰撞，不能只靠到达顺序贴标签。
4. **失去观察后会怎样？** 正常后台、DevTools 关闭、页面冻结/刷新、网络断开、睡眠恢复；reader 停机时新增、重启恢复、通知快速清除。受控环境能做到的故障先模拟，不必为了实验安装整套工具。
5. **究竟省了多少人工动作？** 比较原生基线与候选方案：无效查看次数、需要关注到被发现的时间、找到正确会话的时间、漏报/误报、设置与恢复耗时。自动轮询并非原罪；只要合理且可靠地替代人工轮询，就符合目标。

每个 case 至少分列 task attention time、producer evidence、browser evidence、system evidence、collector seen、target correctness。缺少某层证据就留 unknown；迟到样本保留实际延迟，超时按预设窗口记未检出，不从统计中消失。

## 决策门槛

- 已证明重要状态经常根本不发通知：该来源不能以 notification-only 为主，无需继续优化 DB reader 来补不存在的事件。
- 来源直接事件已覆盖且可归属，而 DB 不提供额外收益：移除强制 enrichment/合流要求。
- 应用级提醒仍显著减少检查：允许这个较弱产品存在，但对外明确能力，不承诺逐任务完成。
- 原生功能已经同样有效：停止复制 Inbox，集中处理仍未解决的跨产品缺口。
- 缺乏精确目标：保留明确的 app-level 行为；不自动猜会话，不重启已停止的 locator 逆向。

**建议的下一动作：先做实际 Browser profile 的来源归因与产品覆盖实验，同时以已支持的 IDE Hook 为比较基线；不要先做新的统一 macOS collector。** 如果后续运行证据证明 Browser/IDE 均持续产生可采集且有用的通知，并且 DB 明显简化总成本，再恢复 DB-first 优先级。
