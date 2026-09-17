# Rally — Browser ↔ IDE Conversation Companion

Rally 是一个连接浏览器端 Agent（如 ChatGPT）与本地 IDE Agent（如 Google Antigravity）的对话伴侣工具。

## 核心定位与目标 (Product)

在跨环境协同开发中，开发者经常需要在浏览器 Agent 与本地 IDE Agent 之间频繁同步上下文与执行结果。Rally 的目标是减少：

- **Copy/Paste**：消除繁琐的手动复制粘贴；
- **Window Switching**：减少跨窗口高频切换；
- **Wrong Project / Wrong Conversation**：防止错误地把消息粘贴到不相关的项目或对话；
- **Conversation Identity Confusion**：清晰绑定会话身份，避免身份混淆；
- **Mechanical Relay**：自动化机械性的上下文传递流程。

## 与 `matt-browser-workflow` 的职责边界 (Relationship)

Rally 与流程规范协议（`matt-browser-workflow`）保持严格的职责正交：

- **`matt-browser-workflow` 负责**：工作流语义（Workflow Semantics）、权威性规则（Authority）、任务契约（Mission Contract）、人类决策边界（Human Decision Boundary）、证据链（Evidence）与门禁校验（Gate）。
- **Rally 只负责**：通信通道（Communication）、会话身份与绑定（Identity / Binding）、状态可见性（State Visibility）、消息传输（Message Transport）、送达确认（Delivery Acknowledgement）以及可选的机械式轮次中继（Optional Mechanical Turn Relay）。

**Rally 绝不重新定义 workflow。**

## 故障隔离原则 (Failure Isolation)

系统必须严格保持单向依赖与故障隔离：

```text
Rally works
→ relay easier

Rally unavailable/broken
→ manual Browser ↔ IDE relay still works
```

Rally 仅作为中继增强工具，**不得**成为 `matt-browser-workflow` 的前置依赖或单点故障（SPOF）。一旦 Rally 异常或不可用，开发者随时可回退到纯手工中继。

## 初始拓扑结构 (Initial Topology)

Phase 1 严格限定为 1:1 单向对等绑定拓扑：

```text
1 ChatGPT Browser conversation
         ↕
  1 Rally binding
         ↕
1 local repository/workspace
         ↕
1 Antigravity Agent conversation
```

当前阶段不构建 Browser 到多个 IDE 会话的自动编排与复杂分发网络。

## 演进路线 (Development Progression)

演进遵循递进式落地原则：

```text
Identity / binding
→ state visibility
→ user-confirmed relay
→ bidirectional relay
→ semi-automatic turn taking
→ gate-aware automation
```

严禁跨越阶段直接构建通用 Agent 调度器（Generic Agent Scheduler）或无边界的无限自动循环。

## 当前技术假设 (Current Technology Hypotheses)

以下仅作为初始阶段待验证的原型假设：

```text
Tampermonkey userscript
→ localhost companion
→ Antigravity CLI
```

仅当原型验证证明其核心价值且 Tampermonkey/localhost 出现确切的技术瓶颈时，才会进一步评估：

```text
Chrome Extension
→ Native Messaging
```

在取得确切证据前，严禁提前进行架构迁移。

## 安全边界 (Security Boundary)

严格禁止以下未经受限的执行链路：

```text
arbitrary webpage text
→ arbitrary shell command
→ execute
```

所有 Browser → 本地的通信必须基于类型化/白名单协议（Typed / Allowlisted Protocol）、经过目标身份双向验证（Target Identity Verification），并始终保留人类决策边界（Human Decision Boundary）。

## 代码规模与工程规范 (Source-size Rule)

本仓库所有源码及工程约束以 [`AGENTS.md`](./AGENTS.md) 为准，不再在 README 重复维护第二套规则。

## 本地状态表面 (Status Surface)

启动本地多项目端点状态监视表面：

```bash
# 生产模式（默认启动干净的空注册表，绝不预填伪造事实）
npm run surface

# 生产模式（加载真实持久化注册表文件；文件不存在时严格 Fail-Closed）
node scripts/start-surface.mjs --storage /path/to/registry.json

# 演练展示模式（显式 --demo 选通，加载包含 Triple NEW、UNKNOWN 及人工介入的演示数据）
npm run surface:demo
# 或 node scripts/start-surface.mjs --demo
```

