# AIHOT：LLM Key 与 Agent Skill 全功能对照

业务只保留一条处理流水线：两种模式共用原有的采集、正文抽取、预筛选、双评分、结构化事实、关系判定、中文摘要、故事合并、热度计算、全文翻译、精选、日报/周报/月报、API 与 UI。区别仅在 `providers/llm.ts::chatJson`：原模式请求模型 API，Agent 模式创建待办，由宿主 Agent 回答，经原 Zod 规则校验并生成可复用的零模型成本 receipt。

| 功能 | LLM Key 模式 | Agent 模式 | 验证现状 |
|---|---|---|---|
| RSS/网页/API、正文抓取及去重 | Worker | 不变 | 18 个已启用信源，本地 148 篇文章 |
| 相关性预筛选 | prefilter_article | 原提示词 Agent 任务 | 203 条已应用 |
| 两次独立评分 | score_article 两次及源级阈值 | 独立 task ID，同一阈值规则 | 284 个评分任务已应用，后继评分留在 A2 同一阶段追加 chunk |
| 事实抽取、类型、标签与中文写作 | structure_article / understand_article / summarize_article | 同一输出 schema | 142 条结构化、134 条理解及 8 条单稿摘要已应用 |
| 事实/故事关联与复核 | group_article / group_review / group_signal / group_story | 同一关系校验与事实归并 | OpenAI 官方公告、TechCrunch 和 The Decoder 的 Orchestra Bio 收购稿通过归组与复核，落入同一个 fact/story |
| 故事摘要、热度 | story_digest / events.hot | Agent 摘要 + 原热度计算 | 74 个有效故事均有综述，热点榜 3 条；故事更新后生成新 digest chunk |
| 全文翻译 | translate_body / translate_quoted | Agent 逐块响应，经原 HTML 校验 | 18个演示源均无全文展示授权，不能代替授权实测 |
| 日报、周/月报 | 原报告生成器及 period prompts | 日报规则不变，周月报需 Agent 回答 | 10/21 08:00 期因冷启动没有已审报道而不生成；10/22 08:00 期的只读预演已有 21 个事件，未提前发刊 |
| API、搜索、RSS、MCP 和网页 | 原 projections | 不变 | 本地 `/`、`/all`、`/hot`、`/daily`、`/api/health` 均 HTTP 200，基础 Smoke 已通过 |
| Embeddings 语义召回 | 独立 Embedding Key 时使用语义向量 | 未配置时沿用原词法回退 | 行为存在精度差异，不能承诺完全相同 |

## 不变量和安全

- Agent 请求 ID 绑定模型路由、prompt、原始输入、subject/revision、版本和双评分序号；防止跨修订复用。
- Agent 提交后仍由原 Zod schema、receipt、PostgreSQL 事务和业务逻辑执行；不直接伪造 analyses / publications。
- `AGENT_REVIEW_ENABLED=true` 时 Worker 仅负责采集，分析、归组、翻译与报表不再由 Worker 自动处理；当前 AI 通过 `scripts/agent-workflow.ts` 调用原业务函数推进全部固定阶段。普通 LLM Key 模式保留原队列与调度。
- **版权必须遵守**：只有 source.site_fulltext=true 且正文有效才可展示和翻译全文。原文已经采集到不等于可以公开转载。18个演示源都是 false。
- Agent 需要在宿主会话主动领取待办；没有 Agent 驻留就不会自动产生完整 AI 结果。这与 API 自动调用的时效性不同。

## 当前验收结论

**2026-10-21 固定阶段整次执行验收成功**：一次 `ai-session` 以 A1 预筛 → A2 两次评分/结构化 → A3 中文编辑 → A4 事实归组与复核 → A5 综述/翻译 → A6 报告/验收推进；同阶段新增任务只追加 chunk，后续采集产生的新任务允许在同一次执行里回到对应阶段。全部阶段通过 `verify.ready=true`，`finish` 清理所有临时 chunk（目录保留且为空），未清空业务数据库。

最终数据库：18 个启用信源、148 篇文章、91 篇公开精选、74 个事实/故事、74 条已生成故事综述和 3 条热点；861 条模型任务 `applied`。5 条旧 `answered` 已被更新的同主体或同故事版本 `applied` 覆盖，验收保留审计记录，不把旧回答冒充已应用；有效待办为 0。`npm run typecheck`、12 项定向单测、CodeGraph `sync/impact`、`git diff --check` 及本地 HTTP 检查通过。

仍待独立验收：明确获得授权的全文展示与翻译、多日真实周/月报、LLM Key 模式跨环境完整回归。**共享业务代码保证规则和功能入口对齐，不保证 Agent 与模型供应商的主观判断、速度及召回精度相同。**

## 热点榜和日报冷启动诊断（2026-10-21）

**数据链路**：普通模式 Worker 每 5 分钟调用 `events/hot.ts::computeHotRanking`，Agent 模式改由当前 AI 直接推动；均读取 `story_signals` 对应的独立参与源，按原文时间取过去 48 小时、24 小时半衰期；热点必须有至少两个独立参与源和一个 editorial 参与源。不同信源实际报道同一事件，并由原 `group_article`/`group_review` 确认归组后，热点才会出现。2026-10-21 已以 OpenAI News 与 TechCrunch 的同一收购事件验证，最终有 3 个真实热点；不降低热度门槛。

**日报链路**：普通模式 Worker 每半小时调用 `reports/compose.ts::composeDueReports`，Agent 模式由当前 AI 直接推进；北京时间每天 08:00 形成截至当日 08:00 的 24 小时窗口，使用 `reports/edition.ts::dailyEdition` 从已评分、公开精选、非历史回灌内容中选取事实/事件，按事件去重、按分组展示并保存到 `reports`。2026-10-21 首次采集在当天 13:00 以后，早于 08:00 截稿时没有可用的已审文章；对应任务报 `daily 2026-10-21: nothing judged in its window`，不能冒充已发布的日报。

**恢复验证**：按原 Skill 完成全批真实新闻的 prefilter、structure、两次 score、understand、group 与 digest。只读调用 `dailyEdition('2026-10-22', 2026-10-21T00:00Z, 2026-10-22T00:00Z)` 得到 `judgedReports=28`、`selectedReports=21`、`events=21`，表明下一期真实候选已具备。截止 2026-10-21 尚未调用 `composeDaily` 提前发布，也未修改 `backfill`、`visible_after` 或日报窗口。后续每天的采集、精选和发布仍需要 Agent 主动执行。

**复现和排查**：`node --env-file=.env scripts/agent-tasks.ts stats` 查看待办；数据库 `hot_rankings`、`story_signals`、`reports`、`publications` 查数据；页面 `/hot`、`/daily` 查实显。对应截图在 `.data/browser-check/hot-20261021.png`、`.data/browser-check/daily-20261021.png`；Chrome 真实加载均 HTTP 200 且无 JS pageerror。
