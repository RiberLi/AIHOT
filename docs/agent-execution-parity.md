# AIHOT：LLM Key 与 Agent Skill 全功能对照

业务只保留一条处理流水线：两种模式共用原有的采集、正文抽取、预筛选、双评分、结构化事实、关系判定、中文摘要、故事合并、热度计算、全文翻译、精选、日报/周报/月报、API 与 UI。区别仅在 `providers/llm.ts::chatJson`：原模式请求模型 API，Agent 模式创建待办，由宿主 Agent 回答，经原 Zod 规则校验并生成可复用的零模型成本 receipt。

| 功能 | LLM Key 模式 | Agent 模式 | 验证现状 |
|---|---|---|---|
| RSS/网页/API、正文抓取及去重 | Worker | 不变 | 18源共抓120篇真实文章 |
| 相关性预筛选 | prefilter_article | 原提示词 Agent 任务 | 实测完成并继续下阶段 |
| 两次独立评分 | score_article 两次及源级阈值 | 独立 task ID，同一阈值规则 | ID单测通过，尚待两次完整分析验收 |
| 事实抽取、类型、标签与中文写作 | structure_article / understand_article / summarize_article | 同一输出 schema | 已创建真实 structure 待办 |
| 事实/故事关联与复核 | group_article / group_review / group_signal / group_story | 同一关系校验与事实归并 | 尚需多来源事件样本 |
| 故事摘要、热度 | story_digest / events.hot | Agent 摘要 + 原热度计算 | 尚需实际归组数据 |
| 全文翻译 | translate_body / translate_quoted | Agent 逐块响应，经原 HTML 校验 | 18个演示源均无全文展示授权，不能代替授权实测 |
| 日报、周/月报 | 原报告生成器及 period prompts | 日报规则不变，周月报需 Agent 回答 | 尚需完成连续多日数据 |
| API、搜索、RSS、MCP 和网页 | 原 projections | 不变 | 既有基础 Smoke 已通过；需全流程回归 |
| Embeddings 语义召回 | 独立 Embedding Key 时使用语义向量 | 未配置时沿用原词法回退 | 行为存在精度差异，不能承诺完全相同 |

## 不变量和安全

- Agent 请求 ID 绑定模型路由、prompt、原始输入、subject/revision、版本和双评分序号；防止跨修订复用。
- Agent 提交后仍由原 Zod schema、receipt、PostgreSQL 事务和业务逻辑执行；不直接伪造 analyses / publications。
- Model Key 关闭且 Agent 开关打开时，Worker 的原分析、归组、翻译、报表调度仍运行，等待外部 Agent 的输出。
- **版权必须遵守**：只有 source.site_fulltext=true 且正文有效才可展示和翻译全文。原文已经采集到不等于可以公开转载。18个演示源都是 false。
- Agent 需要在宿主会话主动领取待办；没有 Agent 驻留就不会自动产生完整 AI 结果。这与 API 自动调用的时效性不同。

## 当前验收结论

已验证：CodeGraph 影响检查、在线迁移规则、类型检查、双评分请求 ID 唯一性、真实 pending→invalid→改正→原 schema→receipt/重用，以及一篇真实文章预筛选完成后自动创建 score/structure 后续待办。

仍待验收：成批文章的双评分到精选/事实归组/热榜/周月报完整数据，明确授权来源的原文/翻译/目录，以及 LLM Key 模式的跨环境完整回归。**共享业务代码保证规则和功能入口对齐，不保证 Agent 与模型供应商的主观判断、速度及召回精度相同。**
