# Rally 真正接收方产物与端到端闭环 Spike 验证报告 (Gate B)

- **日期**: 2026-09-15 (Asia/Shanghai)
- **对应目标**: Gate B — Real Round-Trip with Causally Isolated Receiver-Produced Result
- **最终状态**: **REAL ROUND-TRIP PASS** (独立接收方自主产物 + 运行期 Transcript 因果证明 + 自动多标签页寻址 + 浏览器回传确认)

---

## 1. 核心纠偏与事实澄清

前序两轮测试暴露出的关键证据漏洞：
1. `2693683`: 控制器脚本直接调用 `writeIdeExecutionResult()`，观察到的实质是测试脚本自身创建的文件；
2. `681b052`: 虽然控制器脚本移除了写入，但测试管理与测试接收运行在同一个 IDE 会话上下文 (`8ce57ecd`)，未能提供跨智能体会话的因果隔离独立证据。

### 本轮因果隔离原则 (Causal Isolation Protocol)
1. **角色物理隔离 (`A != B`)**:
   - **Controller (A)**: `8ce57ecd-a678-4e7b-b577-4c2be5987c87` (当前测试编排与监听会话)；
   - **Receiver (B)**: `9abe249f-b053-400b-800f-6433d14ff32c` (经 `agentapi new-conversation` 独立创建的接收方智能体会话)；
2. **控制器只读监听**:
   - 控制器通过 `agentapi send-message` 将包含不可预测 Nonce 的任务发送给 Receiver B；
   - 控制器仅轮询目标产物，**严禁**自行执行任何文件写入命令；
3. **独立 Transcript 因果证明**:
   - 必须核验 Receiver B 本身的运行期日志 (`~/.gemini/antigravity/brain/9abe249f.../transcript.jsonl`)；
   - 证明是 Receiver B 自身收到消息后调用 `write_to_file` 工具创建了该产物；
4. **浏览器端自动化精确定位与回填**:
   - 自动在 Chrome 窗口中定位指定会话 `6aa852d6-f6f0-83e8-aa9d-cc55983cb81b` (`Window 1, Tab 3`)；
   - 严格执行未发送草稿守卫与生成状态守卫；
   - 回传 Receiver B 实际生产的执行结果并等待 ChatGPT 产出 `ACK:<nonce>`。

---

## 2. 独立接收方自主产物与运行期证明

- **评级**: `VERIFIED CURRENT ENVIRONMENT (PASS)`
- **实测证据链**:
  1. **前置基线检查**: 
     - 目标产物在发送前断言不存在：`/tmp/rally-isolated-result-RALLY_ISOLATED_5ccce02c-386c-4810-9c27-8cc7eaefc6cf.json`；
     - Receiver B transcript 基线：2 行，907 字节。
  2. **跨会话任务派发**:
     - Controller A 向 Receiver B (`9abe249f-b053-400b-800f-6433d14ff32c`) 发送测试消息；
  3. **Receiver B 自主执行与产出**:
     - Receiver B 收到系统消息，在步骤 3 (`step_index:3`) 规划调用工具，并在步骤 7 (`step_index:7`) 调用 `write_to_file` 创建产物文件；
     - 文件大小: 147 字节，文件修改时间 `mtime`: `2026-09-14T23:16:13.051Z` (处于发送之后)；
     - 产物内容: `{"nonce":"RALLY_ISOLATED_5ccce02c-386c-4810-9c27-8cc7eaefc6cf","result":"RALLY_ECHO:RALLY_ISOLATED_5ccce02c-386c-4810-9c27-8cc7eaefc6cf"}`；
  4. **Receiver B Transcript 事实**:
     - 执行后 transcript 增长至 9 行，12,057 字节（新增 7 条记录，包含完整的工具调用输入与返回）；
  5. **控制器只读捕获**:
     - Controller A 耗时 14.16 秒观察到该真实外部产物，完全未介入文件生成。

---

## 3. 浏览器指定会话多标签页自动寻址

- **active-tab 依赖是否已移除**: **YES**
- **指定目标会话**: `https://chatgpt.com/c/6aa852d6-f6f0-83e8-aa9d-cc55983cb81b`
- **定位机制与表现**:
  - AppleScript 遍历枚举所有打开的窗口和标签页，将 `6aa852d6` 唯一解析至 `Window 1, Tab 3`；
  - 自动将目标 Tab 激活并带至前台，检测到 Prompt 区域且无未发送草稿 (`promptDraft == ""`，`isGenerating == false`)；
  - 零人工干预，无需人工预先聚焦该标签页。

---

## 4. 真正闭环往返证明 (True Provenance Chain)

```text
1. Request Nonce:                  RALLY_ISOLATED_5ccce02c-386c-4810-9c27-8cc7eaefc6cf
==
2. Controller A (8ce57ecd...):     发送指令至 Receiver B (9abe249f...)
==
3. Receiver B (9abe249f...):       自主调用 write_to_file 生成 /tmp/rally-isolated-result-...
==
4. Controller A 观察提取结果:       RALLY_ECHO:RALLY_ISOLATED_5ccce02c-386c-4810-9c27-8cc7eaefc6cf
==
5. 转发至目标 ChatGPT Tab:          6aa852d6-f6f0-83e8-aa9d-cc55983cb81b (Window 1, Tab 3)
==
6. 目标 ChatGPT 助手 ACK 响应:      ACK:RALLY_ISOLATED_5ccce02c-386c-4810-9c27-8cc7eaefc6cf
```

- **链路耗时**: Receiver B 接收与产出 14.16s + Browser 寻址回填与响应 8.08s = **总计 22.24 秒**。
- **人工复制粘贴**: **0 次**。
- **错误目标投递**: **0 次**。
- **重复执行**: **0 次**。

---

## 5. 安全证据真实性分类

| 检查项 | 证据级别 | 实测结论 |
| :--- | :--- | :--- |
| **会话角色因果隔离 (`A != B`)** | **REAL MULTI-CONVERSATION RUNTIME** | Controller A 编排，Receiver B 独立接收并自主生成产物，Transcript 明确记录工具调用。 |
| **浏览器未发送草稿保护 (Draft Guard)** | **REAL BROWSER RUNTIME** | 存在草稿时前置检查直接阻断 `PREFLIGHT_FAIL: Target has unsent draft`，严格保护用户工作区。 |
| **浏览器多标签页自动寻址** | **REAL BROWSER RUNTIME** | 自动枚举锁定目标 `Window 1, Tab 3`，0 匹配或多匹配立即 fail-closed。 |
| **接收方自主产物生成与提取** | **REAL RUNTIME** | 接收方智能体自主执行写入，控制器无写入调用，仅只读轮询。 |
| **绑定版本过期拒收 (Stale Revision)** | **SYNTHETIC CONTROLLER TEST** | 请求 revision:1 与当前 revision:2 不符时返回 `STALE_REVISION`。 |
| **重复投递幂等去重 (Duplicate Idempotency)** | **SYNTHETIC CONTROLLER TEST** | 相同 exchange_id 重复到达被拦截为 `duplicate_ignored`。 |
| **不确定投递停止自动重试 (Unknown Delivery)** | **SYNTHETIC CONTROLLER TEST** | 发送凭据丢失时标记 `unknown_delivery`，禁止盲目重试。 |
| **全局暂停闩锁 (Pause Latch)** | **SYNTHETIC CONTROLLER TEST** | `paused: true` 时立即拒绝所有新派发。 |

---

## 6. 最终架构定性与下一门禁

* **Gate B 状态**: **REAL ROUND-TRIP PASS** (因果隔离验证通过)
* **架构裁决**: **Hybrid (B) ACCEPTED AS PROTOTYPE ARCHITECTURE**
  - 显式类型化信封承载意图与执行结果；
  - 薄浏览器适配器负责目标会话精确定位、草稿保护与结果回填；
  - IDE 侧由 `agentapi` 消息注入与产物监听器支撑既有 GUI 会话闭环；
  - 彻底摆脱被动重型网络逆向，ChatGPT 官方 MCP 因资格模糊与平台配置复杂继续 **DEFERRED**。

#### 下一门禁 (Next Gate)
> **在已验证的原型往返通道上，执行首个受限只读工程任务（对指定代码文件进行只读审计并输出包含真实 Diff/Summary 的确定性产物回传原对话）。**
