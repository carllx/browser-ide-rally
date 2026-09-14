# ADR: Rally 架构修正决策与接口契约基线

- **日期**: 2026-09-15 (Asia/Shanghai)
- **状态**: ACCEPTED (Architecture Decision Baseline)
- **审查基线**: `be4f02ca94bf2753836187fca34b7d8a77530275`
- **关联 Issue**: Cross-linked to #1 (Phase 0 Signals), #3 (Attention Inbox)

---

## 1. 核心定位与主目标 (Primary Goal)

- **Rally 的首要目标**：实现 **Browser ↔ IDE 任务可靠交接 (Reliable Task Handoff)**，杜绝错目标分发，并在异常时具备明确的状态对账与恢复能力。
- **与 Attention Inbox 的关系**：
  - Attention Inbox 是 Controller 的**可选状态视图/衍生产品 (Optional View / Product)**（展示 `blocked / needs human / stale`），**绝非** Relay 自动化链路的前置依赖 (Prerequisite)。
  - 架构切断“必须先做 Inbox 才能做 Relay”的伪依赖链。

---

## 2. 候选评审结论：`be4f02c` = NOT READY

当前 HEAD `be4f02ca94bf2753836187fca34b7d8a77530275` 判定为：

```text
Phase 3 candidate = NOT READY (NOT PASS)
```

### 阻断性反例证据 (R1–R6)

在 Node 24.3.0 环境下，通过 `docs/research/evidence/rally-review-repro-2026-09-15.mjs` 确定性复现了当前探测实现的 6 项严重语义缺陷：

1. **R1 / P1 (第二轮吞噬)**：network-only 终态保留 activeSession，DOM 路径拒绝终态 session，下一轮无条件复用该对象，导致连续两轮只发一次 completion，第二轮被完全吞噬。
2. **R2 / P1 (身份丢失)**：累积 conversation 仅记录布尔值，入场时仅提取当前 chunk ID；ID 先于 assistant chunk 到达时，终态 `conversation_id` 为 null。
3. **R3 / P1 (ID 误提取与误入场)**：`/tool/id` 满足“不含 user”即被当成 assistant ID；任意非空 `v` 字符串计入有意义增量，非目标流可错误入场。
4. **R4 / P1 (指标自我验收)**：6 条合成 DOM completion + 硬编码 14 即可自动判定 PASS；任何 interrupted 直接标记 VALIDATED，缺乏独立外部 ground truth。
5. **R5 / P1 (Stop 误报为成功)**：用户点击 Stop 导致 DOM 消失，网络 reader 延迟关闭 (>400ms) 时，DOM-only timer 先发出 completed，随后 stopped 事件被 terminal 锁阻断。
6. **R6 / P1 (协议失效静默吞没)**：不支持 compact/handoff 补丁，将未分类流全数统计为 auxiliary ignored，导致协议漂移被伪装成“安全过滤”。

此外，当前 `npm test` 因未关闭的全局 BroadcastChannel handle 导致进程无法正常退出；构建脚本的 esbuild identifier `define` 未能替换字面量 `'__RALLY_VERSION__'`。

---

## 3. 状态域严格分离原则 (Separation of State Domains)

系统严格禁止将生成观测状态与交接授权状态混为一谈，两者为独立状态域：

```text
Generation Observation (观测域)
≠
Handoff Authorization / Delivery (交接/执行域)
```

- **Generation Observation**: 仅描述页面/网络底层的物理活动状态，包括 `running`, `terminal_evidence`, `unknown`, `unsupported`。这仅是**证据 (Evidence)**，绝不等同于可以向下游派发任务。
- **Handoff Authorization**: 仅由受信任的 Controller 基于确定性策略进行判定。交接资格公式必须满足：

```text
eligible(message, binding, policy_revision) =
  explicit_handoff_intent
  AND content_complete_for_this_message
  AND identities_match_current_binding
  AND capability_authorized
  AND recipient_ready
  AND not_already_accepted
  AND no_unresolved_human_gate
```

---

## 4. 最小概念记录 (Minimal Conceptual Records)

系统仅维护以下 5 个最小实体契约，不构建通用调度器 (No Generalized Scheduler)：

1. **Binding (绑定记录)**:
   - `binding_id`, `binding_revision`
   - `browser_scope` (provider, account_scope, conversation_id)
   - `ide_scope` (provider, session_id, normalized_workspace_path, repo_identity)
   - `authorized_capabilities`
2. **Handoff Envelope (交接信封)**:
   - `schema_version`, `message_id` (Rally 传输 ID), `task_id`
   - `binding_id`, `in_reply_to`, `attempt_id`
   - `kind`, `payload_summary`, `artifact_refs`, `expires_at`
3. **Delivery / Accept ACK (送达与接收入库确认)**:
   - `ack_id`, `message_id`, `recipient_session_id`, `accepted_at`, `status` (`accepted` | `rejected` | `deferred`)
4. **Execution Result (执行结果记录)**:
   - `result_id`, `task_id`, `message_id`, `status` (`completed` | `failed` | `blocked`), `summary`, `artifact_refs`, `error_details`
5. **Recovery / Reconciliation State (对账与恢复状态)**:
   - `observer_epoch`, `last_acknowledged_sequence`, `pending_unacknowledged_messages`, `active_attempt_state`
