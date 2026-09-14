# Rally 真实往返闭环与结果观测 Spike 验证报告 (Gate B)

- **日期**: 2026-09-15 (Asia/Shanghai)
- **审查基线**: `09c24ab5ddf25f3f4ce0678d1e9443f964d44bf9`
- **对应目标**: Gate B — True Round-Trip with Independent IDE Result Observation
- **最终状态**: **REAL ROUND-TRIP PASS** (消除控制器预期值合成，实现端到端真实数据流核验)

---

## 1. 核心纠偏与验证目标

> 前序测试存在重大证据缺陷：控制器在 `agentapi send-message` 后直接合成了 `expectedResultText = RALLY_ECHO:<nonce>` 并发送给 Browser，未真正验证 IDE 端的执行产物提取。
>
> 本轮 Spike 的目标：
> 1. 建立独立的 IDE 结果观察器（禁止从请求推断结果）；
> 2. 移除浏览器自动化对“前台活跃标签页”的隐式依赖，实现多窗口/多标签页自动枚举与唯一匹配；
> 3. 严格区分真实运行时安全证据与合成策略测试；
> 4. 执行真正的完整数据往返：`Browser → IDE 执行 → 真实观察到 IDE 结果 → 该真实结果回送 Browser → Browser 产出匹配 ACK`。

---

## 2. Gate 1 — 建立独立 IDE 结果观察器

- **评级**: `VERIFIED CURRENT ENVIRONMENT (PASS)`
- **观察机制**:
  - 方案设计：在任务派发前建立结果文件/产物的时间戳基线 (`getResultBaseline`)；
  - 观察器 (`/tmp/ide_result_observer.js`) 独立轮询监听 IDE 产物落盘文件 (`/tmp/rally_ide_execution_result.json`)，严格比对 `mtime > baseline.mtime` 与 `nonce` 匹配性；
  - 提取实际内容 `extractedResult`，严禁使用发送方请求内容或前缀拼接代替。
- **独立实测证据**:
  - 请求 Nonce: `RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f`；
  - IDE 独立执行后产生结果记录，观察器提取到真实输出：
    `RALLY_ECHO:RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f`。

---

## 3. Gate 2 & Gate 4 — 真正的数据通路往返 (True Round Trip)

- **评级**: `VERIFIED CURRENT ENVIRONMENT (PASS)`
- **实测完整链路**:
  1. **意图构造**: 生成独立随机 Nonce `RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f`；
  2. **IDE 派发**: 经 `agentapi send-message` 注入既有 GUI 会话 `8ce57ecd-a678-4e7b-b577-4c2be5987c87`；
  3. **真实结果提取**: 观察器捕获 IDE 实际落盘的产物文本 `RALLY_ECHO:RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f`；
  4. **Browser 自动寻址与投递**: 自动定位并激活包含 `6aa8762d-102c-83e8-b70d-4d87bc2084de` 的标签页（Window 1, Tab 4），通过前置草稿与繁忙检查后提交**实际提取出的 IDE 结果**；
  5. **Browser 助手响应**: ChatGPT 对话产出响应：
     `ACK:RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f`；
  6. **全链路往返耗时**: 8.81 秒。

```text
Provenance 严格一致性核实：
IDE Requested Nonce:       RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f
==
Actual IDE Result:         RALLY_ECHO:RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f
==
Browser-Delivered Result:  RALLY_ECHO:RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f
==
Browser ACK:               ACK:RALLY_TRUE_cc0157b2-8772-42c1-9ab5-30b40fe5877f
```

---

## 4. Gate 3 — 浏览器寻址语义修正 (Autonomous Tab Targeting)

- **active-tab 依赖是否已移除**: **YES**
- **定位机制**: 编写 `/tmp/browser_resolver.js`，通过 AppleScript 遍历当前 Chrome 所有窗口及标签页：
  - 检查每个 Tab 的 URL 是否包含绑定的 `conversation_id`；
  - 0 个匹配：立即阻断 (`TARGET_LOOKUP_FAIL: ZERO_MATCHES`)，Fail closed；
  - >1 个匹配：立即阻断 (`TARGET_LOOKUP_FAIL: AMBIGUOUS_MATCHES`)，避免多标签页误投；
  - 精确 1 个匹配：自动激活目标窗口并切换至目标 Tab（实测自动锁定 Window 1 Tab 4），随后再进行第二道前置 URL 校验。用户无需手动保持该页面在最前。

---

## 5. 安全证据真实性重分级 (Safety Evidence Classification)

严格区分真实运行时实测与合成策略测试：

| 安全检查项 | 证据类别 | 实测表现 |
| :--- | :--- | :--- |
| **浏览器未发送草稿保护 (Draft Guard)** | **REAL BROWSER RUNTIME** | 输入框注入草稿后，前置检查主动抛出 `PREFLIGHT_FAIL: Target has unsent draft`，严格拒绝覆盖并回滚。 |
| **绑定版本过期拒收 (Stale Revision)** | **SYNTHETIC CONTROLLER TEST** | 请求 revision:1 与当前 revision:2 不符时，返回 `STALE_REVISION` 并拒绝改道。 |
| **重复投递幂等去重 (Duplicate Idempotency)** | **SYNTHETIC CONTROLLER TEST** | 连续两次投递相同 exchange_id，第二次返回 `duplicate_ignored`。 |
| **不确定投递停止自动重试 (Unknown Delivery)** | **SYNTHETIC CONTROLLER TEST** | 发送凭证丢失时标记 `unknown_delivery`，硬性禁止盲目重试。 |
| **全局暂停闩锁 (Pause Latch)** | **SYNTHETIC CONTROLLER TEST** | `paused: true` 时立即返回 `PAUSED` 阻断派发。 |

---

## 6. 架构路线定性与裁决

本轮验证完成后的路线状态：
- **Browser Automation / 薄页面适配器**: **VERIFIED & WORKING** (自动寻址、草稿防护、10s 内可靠往返)。
- **Antigravity agentapi 消息投递**: **VERIFIED** (定向直通当前活跃 GUI 会话)。
- **Antigravity 结果提取机制**: **VERIFIED** (独立文件/产物监听机制已打通)。
- **架构方案**: **Hybrid (B) ACCEPTED**。
  - 显式类型化 Envelope 负责意图与结果承载；
  - 薄页面适配器负责安全寻址、防覆盖回填与触发推理；
  - 现有 IDE 会话由 `agentapi` + 产物监听闭环；
  - 彻底摆脱被动重型 SSE 网络逆向，解脱 Tampermonkey 完成推断包袱。
- **ChatGPT 官方 MCP**: **DEFERRED** (受阻于 Plus 权限模糊与组织配置复杂性)。
- **`be4f02c` 候选**: 维持 **NOT READY**；R1–R6 重型网络解析器修复继续 **FROZEN**。

---

## 7. 下一门禁 (Next Gate)

> **在已验证的 Browser ↔ IDE 真实往返通道上，执行首个受限只读工程任务（文件内容审计并输出真实 Diff/Summary 产物回传原对话）。**
