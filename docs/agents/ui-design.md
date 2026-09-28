# Operator UI 设计原则 (Operator UI Design Principles)

本文件定义 Rally 状态表面的核心设计原则与工程约束。面向 Agent 与开发者，保持原则级定位。

## 1. 核心定位 (Core Identity)

- **状态仪表盘与遥控器**：Rally Surface 是供人类操作者（Operator）快速掌握全局与触发关键操作的状态仪表盘与轻量遥控器，**不是长文阅读页面，也不是沉重的诊断控制台**。
- **深度阅读属于 Agent**：长篇对话阅读、差异分析与深层决策属于协作 Agent；Agent 应当通过 API、结构化状态快照、日志以及 Diagnostics 获取完整上下文。

## 2. 首屏扫描效率 (Viewport & Scan Efficiency)

- **首屏项目聚合**：在标准桌面视口（First Desktop Viewport）内，N 个绑定的多项目应以 N 个紧凑的项目行/卡片形式直接呈现，实现一屏概览。
- **默认扫描语法 (Operator Scan Grammar)**：
  每个项目的紧凑语法为：`项目标识 (Project Identity) + Browser 标签 + IDE 标签 + Latest Result Indicator (红点 ●) + 诚实观察时间 + 仅当前可操作的关注点 (Actionable Attention)`。
- **消除例行状态噪音**：默认扫描视图中严禁渲染常规的 `NEW`、`NO_NEW_RESULT`、“新结果”、“无新结果”等大文本或例行徽章。

## 3. 红点指示器语义 (Latest Result Indicator)

- **非规范派生指示**：红点（●）是基于可靠完成事实推导出的**最新结果指示器 (Latest Result Indicator)**，用于提示哪一侧刚刚产生了新的可靠完成。
- **严禁作为真实源**：红点绝非 Baton、Turn Owner、Delivery Proof 或 Handled 真实源；红点的移动不代表前一端点已被标记处理，亦不改写底层的规范 Dual-NEW 状态。
- **侧级无盲目打点**：若出现仅能确定 IDE 侧最新但无法定位具体端点的情况（Side-level IDE Latest），指示器仅标注于 IDE 分组/侧级，严禁向任意具体 IDE 端点打红点。
- **不确定性显式呈现**：当顺序证据不可靠或存在观察缝隙时，呈现紧凑清晰的 `UNCERTAIN` 标记，严禁偏向任何一侧。

## 4. 渐进式披露与最小冗余 (Progressive Disclosure)

- **首屏仅保留核心意图**：原始 IDs（会话 ID、工作区路径、仓库地址）、版本号、具体游标、精确时间戳、Action 历史表格、Provider 凭证及历史故障一律移至 Details/Diagnostics 折叠区。
- **项目本地关注**：当前需要处理的 actionable 事项（如未解决的人工介入声明、端点未知状态）直接在对应项目行内以紧凑形式就地呈现，默认首屏不设立常驻大托盘霸占空间。
- **诚实的相对时间**：扫描视图使用诚实的相对观察时间（如“观察于 5 分钟前”），避免将观察时间误导为即时完成；精确 ISO 时间戳保存在属性或详情中。
- **能力防御**：针对项目未声明或不支持的能力，在控件层直接隐藏或禁用（disabled），杜绝触发预期的例行报错。
