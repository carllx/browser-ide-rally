# Rally 显式交接接口 Spike 调研与实机验证报告

- **日期**: 2026-09-15 (Asia/Shanghai)
- **基线 Commit**: `bebf5a21da17e3f8dfd8b4681e493ffff60e4be4`
- **对应目标**: Gate B — Bounded Explicit Handoff Interface Spike
- **Gate 状态**: `BLOCKED BY PLATFORM TUNNEL CREATION` (前置 Agent 准备已全量完成)

---

## 1. 核心研究问题

> 能否通过一个类型化、显式的 Browser → Rally → Antigravity → Browser 交接链路，消除将“推断 ChatGPT 普通生成/内容结束”作为主要 Relay 机制的依赖？

---

## 2. 证据纪律与实机能力核验 (Evidence Matrix)

严格遵循五级证据分类：
- `VERIFIED CURRENT ENVIRONMENT` (当前环境实机验证)
- `VERIFIED INSTALLED CONTRACT / RUNTIME EXECUTION NOT YET VERIFIED` (已安装二进制契约已证实，但运行时触发尚未执行)
- `DOCUMENTED ONLY` (仅有官方/权威文档记录，未在当前环境验证)
- `NOT DOCUMENTED / NOT YET VERIFIED` (未有官方文档确立且尚未在实机验证)
- `UNAVAILABLE` (当前环境不可用/不存在)
- `BLOCKED BY PLATFORM TUNNEL CREATION` (受阻于平台隧道凭据与授权)

### A. IDE 侧能力 (Antigravity Environment)

| 能力维度 | 判定状态 | 验证细节与证据来源 |
| :--- | :--- | :--- |
| **会话/工作区身份解析** | `VERIFIED CURRENT ENVIRONMENT` | 经 `/Users/yamlam/.gemini/antigravity/bin/agentapi get-conversation-metadata <id>` 实测：精确返回 `rootConversationId`、`workspaces` (绝对路径与 git repo/branch) 及 `projectId`。SQLite 库 `conversation_summaries.db` 同步记录会话元数据。 |
| **定向注入既有 GUI 会话** | `VERIFIED CURRENT ENVIRONMENT` | 经 `/Users/yamlam/.gemini/antigravity/bin/agentapi send-message --title="..." <recipient_id> <content>` 实机验证：消息作为 `MESSAGE_PRIORITY_HIGH` 系统消息精准投递进当前活跃的主会话上下文，无需新建独立无头进程。 |
| **终态与 fully-idle 判定 (Stop Hook)** | `VERIFIED INSTALLED CONTRACT`<br>`RUNTIME EXECUTION NOT YET VERIFIED` | 二进制 `/Applications/Antigravity.app/Contents/Resources/bin/language_server` 内置 Hooks 框架规范证实：`Stop` Hook 原生提供 `fullyIdle: boolean`、`terminationReason` (`model_stop` / `max_steps_exceeded` / `error`)。 |
| **结构化日志产物** | `VERIFIED CURRENT ENVIRONMENT` (作为本地日志产物) | `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` 原生结构化记录每一步 `tool_calls` 与 `content`。当前作为观察到的本地产物，暂非对外冻结契约接口。 |

### B. Browser 侧能力 (ChatGPT / Secure MCP Tunnel Environment)

| 能力维度 | 判定状态 | 验证细节与证据来源 |
| :--- | :--- | :--- |
| **Stdio MCP 服务端与严格结构化 Schema** | `VERIFIED CURRENT ENVIRONMENT` | 隔离目录 `/tmp/rally-mcp-spike/server.js` 实现 `rally.echo`：同时显式声明 `inputSchema` (`nonce`, `delay_ms`) 与 `outputSchema` (`nonce`, `received_at`, `returned_at`, `delay_ms`)，响应结构化返回 `structuredContent`。 |
| **本地 Schema 与延迟执行验证** | `VERIFIED CURRENT ENVIRONMENT` | 通过本地标准 MCP Client 自动化测试通过：`tool discovery PASS`、`inputSchema PASS`、`outputSchema PASS`、`structuredContent PASS`、`0ms delay PASS`、`500ms delay PASS` (实测 502ms)、`invalid input rejected PASS`、`unknown tool rejected PASS`。 |
| **OpenAI 官方 tunnel-client 环境** | `VERIFIED CURRENT ENVIRONMENT` | 自主下载并安装官方二进制 release v0.0.14 (`0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`) 至 `~/.local/bin/tunnel-client`。命令与自解释检查通过。 |
| **Secure MCP Tunnel 凭据与会话创建** | `BLOCKED BY PLATFORM TUNNEL CREATION` | 当前环境未配置 `CONTROL_PLANE_TUNNEL_ID` 及 `CONTROL_PLANE_API_KEY` (或 `OPENAI_API_KEY`)。`tunnel-client doctor` 确认依赖此两项凭据建立至 OpenAI 控制平面的出站长轮询隧道。 |
| **主动休眠会话唤醒 (Proactive Wake-up)** | `NOT DOCUMENTED / NOT YET VERIFIED` | 服务端单向主动触发休眠 Web 会话产生全新一轮推理目前未有官方规范，亦未在当前环境实机验证。 |
| **被动完成感知 (be4f02c)** | `UNAVAILABLE` (作为可靠交接依据) | R1–R6 六大确定性反例已复现，存在第二轮生成吞噬、Stop 误报为完成等结构性缺陷。 |

---

## 3. 紧凑架构决策矩阵 (Architecture Decision Matrix)

| 选项 / 能力 | 官方/权威文档? | 本地实测通过? | 兼容既有 Browser 会话? | 兼容既有 IDE 会话? | 支持结构化结果返回? | 支持长任务自主续跑? | 需要 Human Gate? | 当前决策状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. 纯显式工具** | YES | 本地 Server PASS | 待实机连接验证 | YES (`agentapi`) | YES (`structuredContent`) | 待测延迟窗口 (0/10/30/60s) | YES (平台隧道与连接) | **OPEN** |
| **B. 混合架构 (Hybrid)** | YES | 部分就绪 | 待实机连接验证 | YES (`agentapi`) | YES (显式信封) | YES (页面适配器协助) | 可控 | **PROVISIONAL HYPOTHESIS** |
| **C. 纯被动推断** | NO | **NO** (`be4f02c` 缺陷) | YES (脚本注入) | YES | NO (聊天文本推断) | YES (若页面保活) | NO | **OPEN FALLBACK** |

---

## 4. 架构裁决与当前状态

- **架构裁决状态**: **OPEN**（暂不提前收敛）。
  - 在平台隧道与连接建立后，实测显式 MCP 在 `0s / 10s / 30s / 60s` 延迟窗口内能够保持挂起并自动恢复同一浏览器会话推理，则选择 **A (Explicit-tool-first)**。
  - 若显式工具处理意图与内容可靠，但长延迟超时导致会话断开且必须依赖浏览器适配器协助重入，则选择 **B (Hybrid)**。
  - 若显式通道在当前 ChatGPT 账号/环境下无法工作，则回退至 **C (Passive Browser adapter primary)**。
- **对 `be4f02c` 与 R1–R6 的状态**:
  - `be4f02c` 维持 **NOT READY**。
  - R1–R6 维持 **FROZEN (冻结状态)**。
