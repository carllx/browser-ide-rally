# Issue #34: Phase 1 Live Surface Refresh and Two-Project Acceptance Gate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现已打开状态表面 (Status Surface) 的只读实时平滑刷新 (Live Refresh) 与故障显性化 (Fail-Visible/Stale)，并基于本地 Rally + PBR 真实持久化绑定完成 Phase 1 最终双项目验收门禁。

**Architecture:**
- **客户端轻量只读投影消费**: 新建 `src/surface/live-refresh-client.js`，通过周期性拉取现有的 `/api/projects` 投影数据，作为纯只读消费者 (read-only projection consumer) 单向同步 DOM，绝不建立第二套 client truth store；
- **状态呈现与用户交互隔离**: 刷新时保持用户已展开的 `<details class="project-details">` 展开状态与操作焦点，红点移动完全从 `latest_result_indicator` 派生；
- **Fail-Visible 故障显式化**: 网络错误或服务端故障时，显式标记 `data-surface-stale="true"` 并展示警示徽章，严禁编造或推测新结果；
- **真实双项目验收隔离**: 读取本地真实持久化存储 (`~/.browser-ide-rally/projects.json`) 中的 `proj-rally-11ca0931` 与 `proj-pbr-26b589fe`，现场动态解析 mutable IDs，本地产出完整的脱敏证据表，确保零隐私泄露进仓库。

**Tech Stack:** Node.js (v24 native modules), JSDOM (for client unit tests), `node:test` (built-in test runner), GitHub CLI (`gh`).

## Global Constraints

- 人工编写代码文件不得超过 600 行，核心源码模块化目标 100-300 行/文件；
- 保持 #27 ordering/observation 语义与 #26 compact operator presentation 语义完全不变；
- 红点严格从 canonical ordering evidence / projection 纯函数推导，绝不作为真实源，红点移动不改写 Endpoint Result / handled 事实；
- 排序歧义保持 UNCERTAIN，绝不猜测；
- 客户端 refresh 必须只读，严禁建立第二套客户端 truth store；
- 刷新失败必须 fail-visible / stale，绝不捏造任何新状态；
- 不实现 Phase 2 功能（delivery confirmation, retry/resend, Tunnel/MCP, #31, #32）；
- 严禁将真实 conversation IDs、本地用户主目录路径或生产快照提交进仓库；
- 在最终 immutable SHA 上执行 locked-Matt Standards + Spec Review，review 之后 no edits。

---

### Task 1: 客户端 Live Surface Refresh 模块设计与实现

**Files:**
- Create: `src/surface/live-refresh-client.js`
- Test: `tests/unit/live-refresh-client.test.js`

**Interfaces:**
- Consumes: `GET /api/projects` (返回 `{ projects: Array, attention_tray: Object }`)
- Produces: `LIVE_REFRESH_CLIENT_JS` 字符串常量供内嵌到 HTML 模版中；导出 `applyProjectionUpdate(doc, projects, attentionTray)` 与 `renderSyncStatus(doc, state)` 工具函数用于单元测试与 DOM 操作。

- [ ] **Step 1: 编写单元测试定义 DOM 增量刷新与 Stale 处理行为**

编写 `tests/unit/live-refresh-client.test.js`：
- 测试当投影从 NO_NEW_RESULT 变为 NEW 时，红点与标签正确转移并显示；
- 测试当多 IDE 处于侧级 IDE_LATEST 时，红点仅打在 IDE 侧级组，子端点不打红点；
- 测试 UNCERTAIN 状态正确渲染且两端均无红点；
- 测试当 fetch 失败时，设置 stale 属性且不更改既有端点状态；
- 测试刷新保留用户原先展开的 details 状态。

- [ ] **Step 2: 运行测试验证失败**

运行: `node --test tests/unit/live-refresh-client.test.js`
预期: FAIL (模块不存在)

- [ ] **Step 3: 实现 `src/surface/live-refresh-client.js`**

编写包含以下职责的纯客户端逻辑：
1. `updateScanRow(card, proj)`: 更新红点、Browser/IDE 标签、相对观察时间、UNCERTAIN 与 Actionable Attention；
2. `updateProjectDetails(card, proj)`: 更新端点 badge、游标文本、handled 按钮属性，保留 `<details>` 的 open 状态；
3. `updateSummaryBar(doc, projects)`: 更新总数与需关注指标；
4. `updateSyncIndicator(doc, { isStale, error, lastSyncTime })`: 更新同步状态指示器；
5. 轮询循环 `startLiveRefreshLoop(intervalMs)`：定期 GET `/api/projects`，失败时进入 stale 模式，成功时消除 stale 状态并应用更新。

- [ ] **Step 4: 运行单元测试验证通过**

运行: `node --test tests/unit/live-refresh-client.test.js`
预期: PASS

- [ ] **Step 5: 提交 Task 1 代码**

```bash
git add src/surface/live-refresh-client.js tests/unit/live-refresh-client.test.js
git commit -m "feat(surface): implement live read-only projection refresh client"
```

---

### Task 2: 页面模版与样式集成

**Files:**
- Modify: `src/surface/surface-template.js`
- Modify: `src/surface/operator-styles.js`
- Modify: `src/surface/surface-client.js`
- Test: `tests/integration/live-surface-refresh.test.js`

**Interfaces:**
- Consumes: `LIVE_REFRESH_CLIENT_JS` from `src/surface/live-refresh-client.js`
- Produces: 完整的状态表面 HTML，附带实时状态指示器 `<div id="surface-sync-indicator">...</div>` 与相关样式。

- [ ] **Step 1: 编写集成测试验证页面结构包含 Live Refresh 脚本与同步指示器**

编写 `tests/integration/live-surface-refresh.test.js`：
- 启动 `startStatusSurfaceServer`；
- 请求 `GET /` 检查 HTML 中包含 `#surface-sync-indicator` 与 live refresh 脚本；
- 模拟后端观察事实演进（例如 Browser 或 IDE 产生新完成）；
- 验证客户端通过请求 `/api/projects` 能在无 reload 的情况下获取到新投影；
- 验证当网络断开时服务端返回错误后呈现 stale。

- [ ] **Step 2: 运行测试验证失败**

运行: `node --test tests/integration/live-surface-refresh.test.js`
预期: FAIL

- [ ] **Step 3: 集成模版与样式**

在 `surface-template.js` 中：
- 在 header 区域加入同步指示器 `<div id="surface-sync-indicator" class="sync-indicator sync-live" title="状态表面实时同步中">● 实时已同步</div>`；
- 引入 `<script>${LIVE_REFRESH_CLIENT_JS}</script>`。

在 `operator-styles.js` 中添加同步与陈旧状态样式：
- `.sync-indicator.sync-live`: 绿色小圆点与文本；
- `.sync-indicator.sync-stale`: 醒目的警示背景与黄色/红色文字；
- `[data-surface-stale="true"]`: 表面陈旧警示条。

在 `surface-client.js` 中：
- 用户触发 Mark handled / Rebind / Continue 后，除了 toast 外，触发全局 `window.__triggerSurfaceRefresh?.()`，实现操作后无需全页刷新的无缝更新。

- [ ] **Step 4: 运行集成测试验证通过**

运行: `node --test tests/integration/live-surface-refresh.test.js`
预期: PASS

- [ ] **Step 5: 提交 Task 2 代码**

```bash
git add src/surface/surface-template.js src/surface/operator-styles.js src/surface/surface-client.js tests/integration/live-surface-refresh.test.js
git commit -m "feat(surface): integrate live refresh indicator and styles into status surface"
```

---

### Task 3: 真实 Rally + PBR 本地双项目验收测试与脱敏工具

**Files:**
- Create: `scripts/run-two-project-acceptance.mjs`
- Create: `tests/integration/two-project-acceptance.test.js`

**Interfaces:**
- Consumes: 本地 `~/.browser-ide-rally/projects.json` 中的 `proj-rally-11ca0931` 与 `proj-pbr-26b589fe`；
- Produces: 结构化的验收结果日志与符合 Browser Lead 要求的脱敏 Before/After 证据表格。

- [ ] **Step 1: 编写双项目集成验收测试**

测试必须覆盖：
1. 真实本地 Rally (`proj-rally-11ca0931`) 与 PBR (`proj-pbr-26b589fe`) 在首屏同时渲染；
2. 动态读取本地持久化注册表，严禁写死历史 conversation ID 或主目录路径；
3. 验证端点独立推进：推进 Rally 的 IDE 端点仅改变 Rally 的 `latest_result_indicator` 与端点状态，PBR 端点完全不受干扰；
4. 验证 Mark handled 推进后，在模拟服务重启（重新加载存储）后 Handled 结果不复发为 NEW；
5. 验证陈旧/断网 (Stale) 模式下，保持现有状态不篡改；
6. 验证已打开 Surface 在不 reload 的情况下反映最新投影。

- [ ] **Step 2: 编写脱敏验收脚本 `scripts/run-two-project-acceptance.mjs`**

脚本自动读取真实配置，脱敏打印：
- binding ID
- endpoint
- old cursor/result/indicator summary
- observed completion source
- new cursor/result/indicator summary
- unaffected-project proof
- restart/handled proof
并校验所有敏感标识符被置换为 `<REDACTED_CONV_ID>` / `<LOCAL_WORKSPACE>` 等。

- [ ] **Step 3: 执行测试与验收脚本**

运行: `node --test tests/integration/two-project-acceptance.test.js`
运行: `node scripts/run-two-project-acceptance.mjs`
预期: 全部通过，输出清晰格式化的脱敏证据表格。

- [ ] **Step 4: 提交 Task 3 代码**

```bash
git add scripts/run-two-project-acceptance.mjs tests/integration/two-project-acceptance.test.js
git commit -m "test(acceptance): add real two-project acceptance gate with sanitized evidence"
```

---

### Task 4: 全套回归与工程约束核验

**Files:**
- Repository-wide verification

- [ ] **Step 1: 运行全量测试**

运行: `npm test`
预期: 全部 350+ 项测试绿灯通过，0 失败。

- [ ] **Step 2: 模块规模核验**

运行: `wc -l src/surface/*.js`
检查: 所有人工代码文件必须 <= 600 行，无违规。

- [ ] **Step 3: Git 状态与隐私检查**

运行: `git status && git diff --cached`
检查: 无任何真实会话 ID、用户家目录路径或敏感 snapshot 被暂存。

---

### Task 5: Locked-Matt Standards + Spec Review

- [ ] **Step 1: 确认 HEAD SHA**
- [ ] **Step 2: 执行 Standards Review (工程与代码规范)**
- [ ] **Step 3: 执行 Spec Review (Issue #34 与 Mission Contract 验收标准对照)**
- [ ] **Step 4: 确认 Review 之后不再做任何代码修改**
- [ ] **Step 5: 整理结构化 Evidence Package 并回复到 GitHub Issue #34**
