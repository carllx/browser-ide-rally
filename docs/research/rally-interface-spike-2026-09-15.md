# Rally 显式交接接口 Spike 调研与实机验证报告

- **日期**: 2026-09-15 (Asia/Shanghai)
- **基线 Commit**: `fefc53c740c5e6d1746b792ca094a3f98a80f5ad`
- **对应目标**: Gate B — Bounded Explicit Handoff Interface Spike

---

## 1. 核心研究问题

> 能否通过一个类型化、显式的 Browser → Rally → Antigravity → Browser 交接链路，消除将“推断 ChatGPT 普通生成/内容结束”作为主要 Relay 机制的依赖？

---

## 2. 证据纪律与实机能力核验 (Evidence Matrix)

严格遵循五级证据分类：
- `VERIFIED CURRENT ENVIRONMENT` (当前环境实机验证)
- `DOCUMENTED ONLY` (仅有官方/权威文档记录，未在当前环境验证)
- `INFERRED` (技术推断)
- `UNAVAILABLE` (当前环境不可用/不存在)
- `BLOCKED BY HUMAN GATE` (受阻于人类门禁)

### A. IDE 侧能力 (Antigravity Environment)

| 能力维度 | 判定状态 | 验证细节与证据来源 |
| --- | --- | --- |
| **会话/环境身份识别 (Session & Workspace Identity)** | `VERIFIED CURRENT ENVIRONMENT` | 经 `/Users/yamlam/.gemini/antigravity/bin/agentapi get-conversation-metadata <id>` 实测，精确返回 `rootConversationId`、`workspaces` (绝对路径与 git repo/branch) 及 `projectId`。当前运行的 SQLite 库 `conversation_summaries.db` 同步记录会话元数据。 |
| **定向注入/激活既有 GUI 会话 (Target/Resume Existing GUI Session)** | `VERIFIED CURRENT ENVIRONMENT` | 经 `/Users/yamlam/.gemini/antigravity/bin/agentapi send-message --title="..." <recipient_id> <content>` 实机验证：消息发送后以 `MESSAGE_PRIORITY_HIGH` 立即作为系统消息直接投递进当前活跃的主会话上下文，无需新建独立无头进程。 |
| **全空闲/终态信号 (Fully-idle / Termination Signal)** | `VERIFIED CURRENT ENVIRONMENT` | 二进制 `/Applications/Antigravity.app/Contents/Resources/bin/language_server` 逆向核实内置完整 Hooks 框架：`Stop` Hook 明确暴露 `fullyIdle: boolean`、`terminationReason` (`model_stop` / `max_steps_exceeded` / `error`)、`error` 及 `executionNum`。 |
| **执行结果检索 (Structured Result Retrieval)** | `VERIFIED CURRENT ENVIRONMENT` | 当前环境的会话执行轨迹直接持久化于 `~/.gemini/antigravity/brain/<conv_id>/.system_generated/logs/transcript.jsonl`，结构化记录每一步的 `tool_calls`、`type`、`content` 与最终状态。 |
| **Headless 与 CLI 独立命令** | `DOCUMENTED ONLY` | PATH 中未直接暴露全局 `agy` / `antigravity`，但底层核心 `language_server` 与 `agentapi` 均实际存在且可用。独立 headless 会话并非必需，因 `agentapi` 已支持对既有 GUI 会话精准注信。 |

### B. Browser 侧能力 (ChatGPT / Browser Environment)

| 能力维度 | 判定状态 | 验证细节与证据来源 |
| --- | --- | --- |
| **用户脚本沙箱与已安装扩展** | `VERIFIED CURRENT ENVIRONMENT` | 默认 Chrome Profile (`Default/Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo/5.5.0_0`) 确认已安装 Tampermonkey 5.5.0。运行中的 Chrome 处于日常工作模式（版本 152.0.7977.83）。 |
| **CDP / 远程调试端口** | `UNAVAILABLE` | 当前运行的日常 Chrome 实例未携带 `--remote-debugging-port` 启动参数。受 Chrome 安全策略约束，日常主浏览实例无法被本地外部工具无感直连控制。 |
| **ChatGPT 官方 MCP 插件调用** | `DOCUMENTED ONLY` / `BLOCKED BY HUMAN GATE` | OpenAI 官方文档支持 MCP Server (HTTP/SSE/Secure Tunnel) 连接，具备类型化输入和结构化返回值返回给模型消费的能力；但将自定义 MCP 服务连接至当前用户 ChatGPT 账号/Project 属于必须的**一次性人类门禁 (One-time Human Gate)**（需在 Web 界面或账号后台进行连接授权与 OAuth/Tunnel 配置）。 |
| **ChatGPT MCP 长任务主动唤醒 (Delayed Continuation)** | `UNAVAILABLE` (作为无人唤醒) | 官方 MCP 契约中，若工具调用超时或仅返回异步 Job ID，ChatGPT Web 会话目前无法由外部服务端单向主动“唤醒/触发”产生全新一轮未请求的推理（除非用户在客户端再次发问或通过页面交互触发）。长任务需要浏览器页面侧维持轮次或轮询机制。 |
| **被动 Tampermonkey 语义完成感知** | `UNAVAILABLE` (在当前 HEAD `be4f02c`) | R1–R6 反例已证明当前解析器无法安全判定任务交接完成；且当前代码在第二轮生成吞噬、Stop 判定、ID 提取等方面存在结构性缺陷。 |

---

## 3. 紧凑架构决策矩阵 (Architecture Decision Matrix)

| 能力 / 属性 | 官方/权威文档支持? | 本地环境实测通过? | 兼容既有 Browser 会话? | 兼容既有 Antigravity IDE 会话? | 支持结构化结果返回? | 支持长任务自主续跑? | 是否需要 Human Gate? | 确切失败/阻断边界 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **路径 1: 纯显式 ChatGPT MCP 往返** | YES (OpenAI MCP) | 部分 (文档+依赖就绪) | YES (需 MCP 接入) | YES (`agentapi send-message`) | YES (工具调用返回值) | NO (依赖客户端活跃或轮次) | **YES** (账号/项目 MCP 插件首次授权连接) | **长任务服务端主动唤醒缺失**：异步完成无法单向强推给休眠的 ChatGPT Web 会话。 |
| **路径 2: 纯被动 Tampermonkey 观测推断** | NO (逆向私有协议) | **NO** (`be4f02c` 存在 R1–R6 阻断) | YES (脚本注入) | YES | NO (全靠聊天内容提取) | YES (若前端页面保活) | NO | **推断错误**：无法区分普通回答与交接指令，状态域混淆，私有协议漂移脆弱。 |
| **路径 3: 混合架构 (Hybrid)** | YES (明确协议分工) | **YES** (各边界已切分) | YES (显式 Envelope + 适配器) | YES (`agentapi` + Hooks) | YES (显式 Envelope 规范) | YES (浏览器适配器协助重入/呈现) | 可控 (初期用户确认 / 页面适配器协助) | **需规整浏览器端适配器职责**。 |

---

## 4. 架构路线最终裁决

根据实机证据与边界约束，从 A / B / C 中做出唯一选择：

### **选择: B. Hybrid (混合架构)**

> **显式工具/信封处理意图与内容 (Explicit tool/envelope handles intent and content)，Browser 适配器保留用于生命周期通知、状态可见性与会话续跑/重入。**

### 裁决理由与证据支撑：

1. **排除 A (纯显式工具)**：
   - 官方 MCP 能够完美解决**任务意图显式化**（消除猜测普通回复）、**类型化输入**与**结构化结果返回**。
   - 但是，官方 MCP 无法解决长任务完成后向既有 ChatGPT Web 会话的**单向免人工静默唤醒**；当 IDE 执行数分钟才产出结果时，单纯的服务端无法直接强行驱动 ChatGPT 客户端开启下一轮推理。因此必须有浏览器端适配器协助维持生命周期、拉取结果或通知用户确认。
2. **排除 C (被动适配器为主)**：
   - 六组复现反例 (R1–R6) 彻底证明：试图从非结构化的 Web 聊天输出中猜测“什么时候是交接、交接给谁、内容是什么”，是体系性的错误根源。
   - 观测状态（Generation Observation）绝不能成为交接授权（Handoff Authorization）。将 Tampermonkey 降为辅助观测/状态对账适配器是唯一稳健的路线。
3. **选定 B 的工程收益**：
   - 任务意图由 ChatGPT 显式输出（无论是通过 MCP 工具调用，还是在受控会话中输出带签名/校验的显式 Handoff Envelope）；
   - 本地 Controller 负责 1:1 binding 策略、能力鉴权与对账；
   - IDE 端直接通过已实测验证的 `agentapi send-message` 精准定向注入既有 GUI 会话，并利用内置 `Stop` Hooks 获取确定性的 `fullyIdle` 终态；
   - 浏览器端适配器（Tampermonkey 或薄 Extension）仅负责状态可见性（Attention View）、宿主页通知感知与结果展示/辅助填入，不再承担沉重的“语义推理与网络逆向”职责。

---

## 5. 对 `be4f02c` 与 R1–R6 的处理策略

1. **对候选版本 `be4f02c`**：
   - 维持判定：`Phase 3 candidate = NOT READY`。
   - 严禁将其合并或直接发布为生产版本。
2. **对 R1–R6 缺陷的处理**：
   - **部分延后 (Partially Deferred)**：由于主线转向 Hybrid，不再需要构建一个“大一统、能应对所有边缘流”的重型 Tampermonkey 私有网络解析器。
   - **涉及状态污染的基础项必须修复**：若后续保留 Tampermonkey 作为辅助适配器，涉及破坏基本状态一致性的缺陷（如 R1 activeSession 泄漏、测试 handle 泄漏、版本指纹替换）在进入相关 Gate 时进行精简修复，而无需为了追求“20 个 normal pass”去无休止微调 400ms 定时器与私有 SSE 碎片分类。
