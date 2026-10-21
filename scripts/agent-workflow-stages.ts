// One execution is a fixed sequence of business stages.
// Chunks only split large input sets INSIDE a stage (CodeGraph CG3-CG5 pattern).
export const AIHOT_STAGES = [
  { id: "A1-prefilter", label: "相关性预筛", purposes: ["prefilter_article"] },
  { id: "A2-analysis", label: "两次评分与事实结构化", purposes: ["score_article", "structure_article"] },
  { id: "A3-editorial", label: "中文理解与编辑", purposes: ["understand_article", "summarize_article", "mend_wording"] },
  { id: "A4-grouping", label: "事实归组与复核", purposes: ["group_article", "group_review", "group_signal", "group_story"] },
  { id: "A5-digest", label: "事件综述与翻译", purposes: ["story_digest", "translate_body", "translate_quoted"] },
  { id: "A6-report", label: "周期报告与最终验收", purposes: ["report_daily", "report_weekly", "report_monthly"] },
] as const;

export type AIHOTStageId = (typeof AIHOT_STAGES)[number]["id"];

export function stageIndexForPurpose(purpose: string): number {
  return AIHOT_STAGES.findIndex(s => (s.purposes as readonly string[]).includes(purpose));
}

export function nextStageForPending(purposes: string[]): number {
  if (!purposes.length) return AIHOT_STAGES.length;
  const indexes = purposes.map(stageIndexForPurpose);
  if (indexes.includes(-1)) throw new Error("Unknown Agent task purpose: " + purposes[indexes.indexOf(-1)]);
  return Math.min(...indexes);
}

export function nextChunkName(index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error("Invalid chunk index");
  return "chunk-" + String(index).padStart(3, "0");
}
