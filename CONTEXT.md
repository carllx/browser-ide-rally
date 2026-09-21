# Rally

Rally 是 Browser Agent 与 IDE Agent 协作时的状态与通信伴侣。它以每个项目的绑定身份为边界，分别保存两端可验证的结果事实，并把动作状态与需要用户介入的决策状态保持分离。

## Language

**Project Binding**:
Rally 拥有的稳定项目关联，把一个 Rally 项目连接到明确的 Browser conversation 与 IDE conversation；重新绑定会产生新的 binding revision，而不是新建项目。
_Avoid_: window position, tab index, UI position

**Project Display Name**:
面向人类操作者的项目显示标签，可读且便于识别，在当前 Rally 注册表内唯一。它独立于且绝不替代规范的 Project Binding 身份、会话 ID、工作区或仓库身份。
_Avoid_: canonical binding ID, project identity synonym

**Endpoint Result**:
一个能够被可靠归属到某个 bound Browser 或 IDE conversation 的已完成 Agent turn。Browser 与 IDE 的 Endpoint Result 彼此独立。
_Avoid_: owner, baton

**New Result**:
一个可靠完成、但尚未被 Rally 明确标记为 handled 的 Endpoint Result。Browser 与 IDE 可以同时各自拥有 New Result。
_Avoid_: next turn, current owner

**Handled Result**:
一个其 attention lifecycle 已被 Rally 可靠消费或明确处理完成的 Endpoint Result。推进途径唯二：(1) 显式手动 Mark handled；(2) 由针对源 NEW 结果、具备完备强关联凭据的 user-directed Continue Action 达到 ACCEPTED_OR_DELIVERED 时自动推进。普通投递、REQUESTED、SUBMITTED_LOCALLY、UNKNOWN 或关联不全的动作绝不推进 Handled；亦无需等待 TARGET_COMPLETED。
_Avoid_: last relayed as a synonym

**Unknown Result State**:
Rally 无法可靠确认某个 endpoint 的 completion continuity 或归属时使用的状态。Unknown 表示“不知道”，绝不表示“没有新结果”。
_Avoid_: idle, no result

**Human Intervention**:
明确需要用户作出决定或执行受信任边界内操作的项目状态。它独立于 Browser/IDE completion 与 action lifecycle，也不是第三个 endpoint。
_Avoid_: human owns the turn, human endpoint

**Attention Tray**:
从项目的 Endpoint Result、Human Intervention 与 action/safety facts 派生出的注意力视图。它帮助跨项目扫描，但不是新的 canonical state store。
_Avoid_: authoritative handoff queue

**Derived Status Hint**:
完全从 canonical project truth 计算出的紧凑视觉摘要，可用于快速扫视，但没有独立持久状态，也不代表唯一 owner 或“轮到谁”。
_Avoid_: Baton Location, turn owner, next actor

**Action Lifecycle**:
一次 open/focus/send/handoff 操作的独立事实序列：Action Requested、Submitted Locally、Accepted/Delivered、Target Completed。后一个阶段不能由前一个阶段自动推断。
_Avoid_: sent, handoff complete

**Result Identity**:
端点本地唯一的稳定结果标识（例如 message ID、turn UUID 或 monotonic turn cursor）。它由各 provider 本地生成与管理，不等同于跨端点的全局 message ledger，绝对不能跨端点直接做大小比较。
_Avoid_: global message ID, universal turn clock

**Result Time Evidence**:
端点结果的时间凭据。明确区分三类性质不同的时间信息：(1) provider-attested result timestamp（若端点提供）；(2) observer-witnessed event timestamp（Rally 实时见证完成时的受信任单调时间戳）；(3) observation-time monotonic sequence counter（观测时序计数器）。绝不将不同 provider 的本地物理时间戳直接混同做跨端因果比较。
_Avoid_: synchronized wall clock, cross-provider NTP equivalence

**Latest Result Indicator**:
面向人类操作者的派生 UI 视觉指示（如 `BROWSER_LATEST`、`IDE_LATEST`、`UNCERTAIN`、`NONE`），用于快速呈现哪个端点在时序上最后完成产出。它完全从各端点事实及 Ordering Evidence 纯函数派生，绝不作为第二套持久化 UI 状态存储，且与结果的 New/Handled 状态严格解耦。
_Avoid_: turn owner, baton, unread badge store

**Ordering Evidence / Trusted Ordering Checkpoint**:
Rally 内部记录的跨端点完成顺序凭证与持久检查点。包含各端点已知的最新完成游标与最后受信任完成的端点标识。仅在实时见证（live-witnessed）完成或重启/gap 后的单侧受控事实推进时更新；任何存在未受信任观测间隙（untrusted gap）且无法确定确切先后的情况，必须裁决为 UNCERTAIN。
_Avoid_: speculative ordering, wall-clock arbitration

