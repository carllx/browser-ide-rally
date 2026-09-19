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
