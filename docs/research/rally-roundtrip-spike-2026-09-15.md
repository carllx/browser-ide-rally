# Rally 真正接收方产物与端到端闭环 Spike 验证报告 (Gate B)

- **日期**: 2026-09-15 (Asia/Shanghai)
- **审查基线**: `269368325158986a71f511feada69aca27d2656d`
- **对应目标**: Gate B — Real Round-Trip with Receiver-Produced IDE Result
- **最终状态**: **REAL ROUND-TRIP PASS** (接收方自主产物提取 + 自动多标签页寻址 + 浏览器端无人工确认)

---

## 1. 核心纠偏与事实澄清

> 前序测试存在严重证据越级漏洞：控制器在执行 `agentapi send-message` 后自行调用了写入函数生成结果文件，因此观察到的产物实质上是发送方伪造的。
>
> **本轮纠偏原则**:
> 1. 控制器**严禁**自行写入或伪造结果，只允许 `send`、`poll`、`verify`、`forward`；
> 2. 接收方（Antigravity IDE 智能体会话）必须在接收到任务后，**由自身执行动作独立创建结果文件**；
> 3. 控制器仅在产物出现且校验 Nonce 一致后，转发该真实结果至指定的全新 ChatGPT 会话；
> 4. 浏览器端会话自动从多窗口/多标签页中准确定位至全新指定目标：`6aa852d6-f6f0-83e8-aa9d-cc55983cb81b`。

---

## 2. 接收方自主产物验证 (Receiver Execution Evidence)

- **评级**: `VERIFIED CURRENT ENVIRONMENT (PASS)`
- **证据链与机制**:
  1. **前置基线检查**: 控制器在派发前，严格断言目标文件不存在：
     `/tmp/rally-receiver-result-RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb.json`。
  2. **任务派发**: 经 `agentapi send-message` 将指令发送给现有 GUI 会话 `8ce57ecd-a678-4e7b-b577-4c2be5987c87`。
  3. **接收方自主写入**: 接收方 IDE Agent 响应消息，调用文件写入工具独立生成该 JSON 产物。
  4. **控制器严格只读监听**: 控制器轮询并捕获该文件，读取到真实内容：
     `{"nonce":"RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb","result":"RALLY_ECHO:RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb"}`。
  5. **排除控制器伪造证据**: 控制器代码中彻底移除任何写入调用，时间戳核验 `mtime > tPreSend`，耗时 11.23 秒。

---

## 3. 浏览器指定会话多标签页自动寻址 (Autonomous Browser Targeting)

- **active-tab 依赖是否已移除**: **YES**
- **指定目标会话**: `https://chatgpt.com/c/6aa852d6-f6f0-83e8-aa9d-cc55983cb81b`
- **定位机制与表现**:
  - 通过 AppleScript 自动遍历所有窗口和标签页，成功将 `6aa852d6` 唯一定位至 `Window 1, Tab 3`；
  - 自动将目标 Tab 切换到前台，执行前置草稿检查与繁忙检查；
  - 零人工干预，无需用户预先切回或保持该页面在前台。

---

## 4. 真正闭环往返证明 (True Provenance Chain)

```text
1. 派发 Nonce:                  RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb
==
2. 接收方独立生成文件:          /tmp/rally-receiver-result-RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb.json
==
3. 观察到的真实接收方产物:      RALLY_ECHO:RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb
==
4. 转发至 Browser 文本:         RALLY_ECHO:RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb
==
5. 目标 ChatGPT 助手 ACK 响应:   ACK:RALLY_PROVEN_863741b3-0782-479f-83f2-58ddb21c34fb
```

- **链路耗时**: IDE 接收与产出 11.23s + Browser 寻址回填与推理 3.65s = **总计 14.88 秒**。
- **人工复制粘贴**: **0 次**。
- **错误目标投递**: **0 次**。
- **重复执行**: **0 次**。

---

## 5. 安全证据真实性分类 (Safety Evidence Classification)

| 检查项 | 证据级别 | 实测结论 |
| :--- | :--- | :--- |
| **浏览器未发送草稿保护 (Draft Guard)** | **REAL BROWSER RUNTIME** | 存在草稿时前置检查直接阻断 `PREFLIGHT_FAIL: Target has unsent draft`，严格保护用户工作区。 |
| **浏览器多标签页自动寻址** | **REAL BROWSER RUNTIME** | 自动枚举锁定目标 `Window 1, Tab 3`，0 匹配或多匹配立即 fail-closed。 |
| **接收方自主产物生成与提取** | **REAL RUNTIME** | IDE Agent 自主执行写入，控制器无写入调用，仅读取验证。 |
| **绑定版本过期拒收 (Stale Revision)** | **SYNTHETIC CONTROLLER TEST** | 请求 revision:1 与当前 revision:2 不符时返回 `STALE_REVISION`。 |
| **重复投递幂等去重 (Duplicate Idempotency)** | **SYNTHETIC CONTROLLER TEST** | 相同 exchange_id 重复到达被拦截为 `duplicate_ignored`。 |
| **不确定投递停止自动重试 (Unknown Delivery)** | **SYNTHETIC CONTROLLER TEST** | 发送凭据丢失时标记 `unknown_delivery`，禁止盲目重试。 |
| **全局暂停闩锁 (Pause Latch)** | **SYNTHETIC CONTROLLER TEST** | `paused: true` 时立即拒绝所有新派发。 |

---

## 6. 最终架构定性与下一门禁

* **Gate B 状态**: **REAL ROUND-TRIP PASS**
* **架构裁决**: **Hybrid (B) ACCEPTED AS PROTOTYPE ARCHITECTURE**
  - 显式类型化信封承载意图与执行结果；
  - 薄浏览器适配器负责目标会话精确定位、草稿保护与结果回填；
  - IDE 侧由 `agentapi` 消息注入与产物监听器支撑既有 GUI 会话闭环；
  - 彻底摆脱被动重型网络逆向，ChatGPT 官方 MCP 因资格模糊与平台配置复杂继续 **DEFERRED**。

#### 下一门禁 (Next Gate)
> **在已验证的原型往返通道上，执行首个受限只读工程任务（对指定代码文件进行只读审计并输出包含真实 Diff/Summary 的确定性产物回传原对话）。**
