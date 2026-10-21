// Current-AI-controlled synchronous engine. No downstream pg-boss workers.
import { sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle } from "@aihot/backend/jobs/content";
import { groupArticle } from "@aihot/backend/events/group";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { translatePending } from "@aihot/backend/editorial/translate";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { linkRelatedStories } from "@aihot/backend/events/consolidate";
import { composeDueReports } from "@aihot/backend/reports/compose";

const CONTENT_PURPOSES = new Set([
  "prefilter_article","score_article","structure_article",
  "understand_article","summarize_article","mend_wording",
]);

export function subjectsToTargets(items: Array<{ subject: string; purpose: string }>) {
  const articleIds = new Set<string>();
  const storyIds = new Set<number>();
  for (const item of items) {
    if (CONTENT_PURPOSES.has(item.purpose) || item.purpose.startsWith("group_")) {
      const id = /^article:([^@:#]+)/.exec(item.subject)?.[1];
      if (id) articleIds.add(id);
    }
    if (item.purpose === "story_digest") {
      const id = Number(/^story:(\d+)/.exec(item.subject)?.[1]);
      if (Number.isInteger(id) && id > 0) storyIds.add(id);
    }
  }
  return { articleIds: [...articleIds], storyIds: [...storyIds] };
}

interface AdvanceOutcome {
  articles: Array<{ id: string; state: string }>;
  groups: Array<{ id: string; verdict: string }>;
  digests: Array<{ id: number; updated: boolean }>;
  translation: { done: number; quotes: number };
  hot: { entries: number };
  storyLinks: number;
  reports: { generated: string[]; failed: string[] };
  warnings: string[];
}
export async function advanceAgentWorkflow(opts: {
  articleIds?: string[];
  storyIds?: number[];
  limit?: number;
  includeScheduled?: boolean;
} = {}): Promise<AdvanceOutcome> {
  if (process.env.AGENT_REVIEW_ENABLED !== "true") throw new Error("AGENT_REVIEW_ENABLED=true required");
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const report: AdvanceOutcome = { articles: [], groups: [], digests: [],
    translation: { done: 0, quotes: 0 }, hot: { entries: 0 }, storyLinks: 0,
    reports: { generated: [], failed: [] }, warnings: [] };
  const warn = (stage: string, id: string | number, error: unknown) =>
    report.warnings.push(stage + ":" + id + ": " + String(error).slice(0, 200));
  const ids = new Set((opts.articleIds ?? []).slice(0, limit));
  if (opts.articleIds === undefined && ids.size < limit) {
    // Resume answers that already exist before seeding another batch of news.
    // Otherwise new collection endlessly pushes completed AI chunks back.
    const answered = await sql<{ id: string }[]>`
      SELECT DISTINCT a.id, a.discovered_at FROM articles a
      JOIN agent_model_requests r
        ON split_part(split_part(r.subject,'@',1),':',2)=a.id
      WHERE a.processing_state='new' AND r.status='answered'
        AND r.purpose IN ('prefilter_article','score_article','structure_article','understand_article')
      ORDER BY a.discovered_at DESC LIMIT ${limit}`;
    for (const row of answered) ids.add(row.id);
  }
  if (opts.articleIds === undefined && ids.size < limit) {
    const grouping = await sql<{ id: string }[]>`
      SELECT a.id FROM articles a JOIN sources s ON s.id=a.source_id
      WHERE a.grouping_status='pending'
        AND ((s.participation_mode='editorial' AND a.processing_state='analyzed'
          AND EXISTS (SELECT 1 FROM analyses an WHERE an.article_id=a.id
            AND an.input_revision=a.revision AND an.relevance='pass'))
          OR (s.participation_mode='hot_signal' AND a.processing_state='skipped'))
      ORDER BY a.discovered_at DESC LIMIT ${Math.min(limit, 15)}`;
    for (const row of grouping) ids.add(row.id);
  }
  if (opts.articleIds === undefined && ids.size < limit) {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM articles WHERE processing_state='new'
      ORDER BY discovered_at DESC LIMIT ${limit - ids.size}`;
    for (const row of rows) ids.add(row.id);
  }
  const storyIds = new Set(opts.storyIds ?? []);
  for (const id of ids) {
    try {
      const [a] = await sql<{ body_status: string; processing_state: string }[]>`
        SELECT body_status,processing_state FROM articles WHERE id=${id}`;
      if (!a) continue;
      if (a.processing_state === "new") {
        if (a.body_status === "pending") {
          try { await extractArticleBody(id); } catch (error) { warn("extract", id, error); }
        }
        const res = await processArticle(id);
        report.articles.push({ id, state: res.state });
      }
      const [current] = await sql<{
        processing_state: string; grouping_status: string;
        participation_mode: string; passed: boolean;
      }[]>`
        SELECT a.processing_state,a.grouping_status,s.participation_mode,
          EXISTS (SELECT 1 FROM analyses an WHERE an.article_id=a.id
             AND an.input_revision=a.revision AND an.relevance='pass') AS passed
        FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${id}`;
      if (current && current.grouping_status === "pending" &&
        ((current.processing_state === "analyzed" && current.passed) ||
         (current.processing_state === "skipped" && current.participation_mode === "hot_signal"))) {
        try {
          const grouped = await groupArticle(id, { signalOnly: current.participation_mode === "hot_signal" });
          report.groups.push({ id, verdict: grouped.verdict });
          if (grouped.storyId) storyIds.add(grouped.storyId);
        } catch (error) { warn("group", id, error); }
      }
    } catch (error) { warn("article", id, error); }
  }
  if (opts.includeScheduled !== false) {
    const rows = await sql<{ id: number }[]>`
      SELECT id FROM stories WHERE merged_into IS NULL ORDER BY updated_at DESC LIMIT ${limit}`;
    for (const row of rows) storyIds.add(row.id);
  }
  for (const id of [...storyIds].slice(0, limit)) {
    try {
      const out = await composeStoryDigest(id);
      report.digests.push({ id, updated: out.updated });
    } catch (error) { warn("digest", id, error); }
  }
  if (opts.includeScheduled !== false) {
    try {
      const translated = await translatePending({ limit: Math.min(limit, 20), budgetMs: 10_000 });
      report.translation = { done: translated.done.length, quotes: translated.quotes };
    } catch (error) { warn("translate", "pending", error); }
    try { report.hot.entries = (await computeHotRanking()).entries; }
    catch (error) { warn("hot", "rank", error); }
    try { report.storyLinks = (await linkRelatedStories()).added; }
    catch (error) { warn("stories", "links", error); }
    try { report.reports = await composeDueReports(new Date(), 8); }
    catch (error) { warn("reports", "due", error); }
  }
  return report;
}
