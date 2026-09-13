# Repository Agent Guidelines: browser-ide-rally

本文件为 `browser-ide-rally` 仓库的顶级 Agent 规则指南。Agent 在本仓库中工作时必须遵循以下准则。

## 模块规模与工程约束

- **文件行数上限**：人工编写的代码文件不得超过 **600 行**。
- **主动拆分阈值**：当人工代码接近约 **500–600 行**时，应主动检查是否存在自然职责拆分边界，并在超过 600 行之前完成合理拆分。
- **核心源码模块化目标**：Browser / Tampermonkey 等核心源码继续以约 **100–300 行/文件**作为优先设计目标。
- **轻量构建与配置**：build/config scripts 保持轻量，不构建重型单文件脚本。
- **生成产物规模豁免与定位**：generated bundle / build artifact 可以超过 600 行，但必须明确属于 generated artifact，并不得成为 Agent 日常主要编辑、理解和 Review 的入口。
- **源码优先原则**：Agent 默认优先阅读、修改和 Review 模块化源码；只有诊断构建/发布问题确有必要时才直接检查 generated artifact。
- **内聚性优先**：不为了凑行数而机械拆分自然内聚逻辑。

## Agent skills

### Issue tracker

GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default 5-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.
