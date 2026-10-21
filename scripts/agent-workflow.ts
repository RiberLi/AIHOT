// AIHOT fixed-stage workflow, matching codegraph-project:
// one execution -> A1..A6 -> stage-local chunks -> stage merge/verify -> finish.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { submitAgentTasks } from "@aihot/backend/providers/agent-bridge";
import { partitionTasks, safeSessionName, validateAgentChunk, type AgentChunk, type AgentChunkTask } from "./agent-workflow-lib.ts";
import { advanceAgentWorkflow, subjectsToTargets } from "./agent-advance.ts";
import { sessionCleanup } from "./agent-workflow-cleanup.ts";
import { AIHOT_STAGES, nextStageForPending, nextChunkName } from "./agent-workflow-stages.ts";

if (process.env.AGENT_REVIEW_ENABLED !== "true") throw new Error("AGENT_REVIEW_ENABLED=true required");
const [action, ...args] = process.argv.slice(2);
const opt = (key: string, fallback?: string) => {
  const i = args.indexOf("--" + key);
  return i < 0 ? fallback : args[i + 1];
};
const positive = (key: string, fallback: number, max: number) => {
  const n = Number(opt(key, String(fallback)));
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(key + " must be 1.." + max);
  return n;
};
const session = safeSessionName(opt("session", "ai-session")!);
const home = resolve(".data/agent-workflow", session);
const executionPath = join(home, "execution.json");

type ChunkFile = { file: string; output: string; count: number };
type StageManifest = {
  schemaVersion: 2; session: string; stage: string; createdAt: string;
  chunkSize: number; chunks: ChunkFile[]; total: number;
};
type Execution = {
  schemaVersion: 2; session: string; startedAt: string; stageIndex: number;
  completedStages: string[];
};
type StageTaskRow = {
  id: string; purpose: string; subject: string; prompt_version: string;
  request: AgentChunkTask["request"]; status: AgentChunkTask["status"]; error: string | null;
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
function saveJson(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(tmp, path);
}
const stageDir = (index: number) => join(home, AIHOT_STAGES[index].id);
const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
function execution(): Execution {
  if (existsSync(executionPath)) return readJson<Execution>(executionPath);
  const state: Execution = { schemaVersion: 2, session, startedAt: new Date().toISOString(),
    stageIndex: 0, completedStages: [] };
  saveJson(executionPath, state);
  return state;
}
async function openTasks(purposes?: readonly string[]) {
  return await sql<StageTaskRow[]>`
    SELECT id,purpose,subject,prompt_version,request,status,error
    FROM agent_model_requests
    WHERE status IN ('pending','invalid')
      AND (${purposes ?? null}::text[] IS NULL OR purpose = ANY(${purposes ?? null}::text[]))
    ORDER BY created_at,id`;
}
async function globalPending() {
  return await sql<{ purpose: string; status: string; n: number }[]>`
    SELECT t.purpose,t.status,count(*)::int n FROM agent_model_requests t
    WHERE t.status IN ('pending','invalid','answered')
      AND NOT (t.status='answered' AND EXISTS (
        SELECT 1 FROM agent_model_requests newer
        WHERE newer.purpose=t.purpose
          AND (newer.subject=t.subject OR
            (t.purpose='story_digest' AND split_part(newer.subject,'@',1)=split_part(t.subject,'@',1)))
          AND newer.status='applied' AND newer.created_at>t.created_at))
    GROUP BY t.purpose,t.status ORDER BY t.purpose,t.status`;
}
async function advanceTargets(targets: { articleIds: string[]; storyIds: number[] }) {
  const results = [];
  for (let i = 0; i < targets.articleIds.length; i += 40) {
    results.push(await advanceAgentWorkflow({ articleIds: targets.articleIds.slice(i, i + 40),
      limit: 40, includeScheduled: false }));
  }
  const scheduled = await advanceAgentWorkflow({ articleIds: [], storyIds: targets.storyIds,
    limit: 40, includeScheduled: true });
  return { articleBatches: results, scheduled };
}
function currentStage(state: Execution) {
  if (state.stageIndex >= AIHOT_STAGES.length) return null;
  return AIHOT_STAGES[state.stageIndex];
}
async function prepare(state: Execution) {
  // Seed business prompts without asking another process to perform the AI reasoning.
  // New collection is allowed; its generated tasks will be included at the stage gate.
  let advanced = false;
  for (let attempt = 0; attempt <= AIHOT_STAGES.length; attempt++) {
    const stage = currentStage(state);
    if (!stage) {
      const remaining = (await openTasks()).map(x => x.purpose);
      if (remaining.length) {
        const index = nextStageForPending(remaining);
        state.stageIndex = index;
        state.completedStages = state.completedStages.filter(x => x !== AIHOT_STAGES[index].id);
        // Reopen this fixed stage without reusing its stale completion marker.
        rmSync(join(stageDir(index), "merged.json"), { force: true });
        saveJson(executionPath, state);
        continue;
      }
      print({ execution: session, stages: AIHOT_STAGES.length, status: "stages-finished",
        next: "verify and finish only when all business and model records pass" });
      return;
    }
    const folder = stageDir(state.stageIndex);
    const manifestPath = join(folder, "manifest.json");
    if (existsSync(join(folder, "merged.json"))) {
      const alreadyVerified = state.completedStages.includes(stage.id);
      if (!alreadyVerified) {
        throw new Error("Stage merge is complete but requires verification: " + stage.id + ". Run verify first.");
      }
      const newPending = await openTasks(stage.purposes);
      if (!newPending.length) {
        // This fixed stage passed earlier in the same execution: skip it,
        // not a new round, and never re-submit its old chunks.
        state.stageIndex++;
        saveJson(executionPath, state);
        continue;
      }
      // New collection/analysis created more tasks for a verified stage.
      // Keep the existing manifest, inputs and applied chunks as the audit
      // trail; only reopen the stage gate and append fresh chunks below.
      rmSync(join(folder, "merged.json"));
      state.completedStages = state.completedStages.filter(id => id !== stage.id);
      saveJson(executionPath, state);
    }
    const manifest = existsSync(manifestPath) ? readJson<StageManifest>(manifestPath) : null;
    const progressPath = join(folder, "merge-progress.json");
    const progress = existsSync(progressPath)
      ? readJson<{ submitted: number[] }>(progressPath) : { submitted: [] as number[] };
    const unanswered = manifest?.chunks
      .map((x, i) => ({ ...x, number: i + 1 }))
      .filter(x => !progress.submitted.includes(x.number)) ?? [];
    if (unanswered.length) {
      print({ execution: session, stage: stage.id, name: stage.label,
        chunks: manifest!.chunks.length, remainingChunks: unanswered.map(x => x.file),
        folder, next: "complete all missing output chunks before merge" });
      return;
    }
    // Only start a new set of chunks after the previous stage chunks were merged.
    if (!advanced) {
      await advanceAgentWorkflow({ limit: 40 });
      advanced = true;
    }
    const rows = (await openTasks(stage.purposes)).slice(0, positive("limit", 2000, 10000));
    if (rows.length) {
      const size = positive("chunk-size", 8, 20);
      mkdirSync(folder, { recursive: true });
      const next: StageManifest = manifest ?? { schemaVersion: 2, session, stage: stage.id,
        createdAt: new Date().toISOString(), chunkSize: size, chunks: [], total: 0 };
      const known = new Set<string>();
      for (const entry of next.chunks) {
        const chunk = readJson<AgentChunk>(join(folder, entry.file));
        for (const item of chunk.items) known.add(item.id);
      }
      const newItems = rows.filter(r => !known.has(r.id)).map(r => ({
        id: r.id, purpose: r.purpose, subject: r.subject, promptVersion: r.prompt_version,
        status: r.status, error: r.error, request: r.request,
      }));
      if (!newItems.length) {
        throw new Error("Stage still has pending task IDs already in submitted chunks; inspect invalid/stale results: " + stage.id);
      }
      for (const items of partitionTasks(newItems, size)) {
        const index = next.chunks.length + 1;
        const filename = nextChunkName(index);
        const input = filename + ".input.json";
        const output = filename + ".output.json";
        saveJson(join(folder, input), { session, stage: stage.id, chunk: index, items });
        next.chunks.push({ file: input, output, count: items.length });
      }
      next.total += newItems.length;
      saveJson(manifestPath, next);
      print({ execution: session, stage: stage.id, name: stage.label,
        stageTotal: next.total, newTasks: newItems.length, totalChunks: next.chunks.length,
        folder, next: "AI must answer each new chunk, then merge this stage" });
      return;
    }
    // A stage is complete only when its own purpose set is fully consumed.
    if (manifest && progress.submitted.length !== manifest.chunks.length) {
      throw new Error("Cannot advance an unmerged stage: " + stage.id);
    }
    saveJson(join(folder, "merged.json"), { stage: stage.id,
      chunks: manifest?.chunks.length ?? 0, total: manifest?.total ?? 0,
      completedAt: new Date().toISOString() });
    if (!state.completedStages.includes(stage.id)) state.completedStages.push(stage.id);
    state.stageIndex++;
    saveJson(executionPath, state);
  }
  throw new Error("Exceeded stage transition limit");
}
async function merge(state: Execution) {
  const stage = currentStage(state);
  if (!stage) throw new Error("All stages have finished");
  const folder = stageDir(state.stageIndex);
  const manifestPath = join(folder, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Prepare the stage before merge: " + stage.id);
  const manifest = readJson<StageManifest>(manifestPath);
  const progressPath = join(folder, "merge-progress.json");
  const progress = existsSync(progressPath)
    ? readJson<{ submitted: number[] }>(progressPath) : { submitted: [] as number[] };
  // CodeGraph quality gate: validate all stage chunks BEFORE writing any unanswered ones.
  const validated = manifest.chunks.map(c => {
    const chunk = readJson<AgentChunk>(join(folder, c.file));
    if (!existsSync(join(folder, c.output))) throw new Error("Missing AI output: " + join(folder, c.output));
    return { chunk, value: validateAgentChunk(chunk, readJson<unknown>(join(folder, c.output))) };
  });
  const items = validated.flatMap(x => x.chunk.items);
  if (new Set(items.map(x => x.id)).size !== items.length ||
      items.length !== manifest.total) throw new Error("Duplicate or missing stage task ID");
  for (let i = 0; i < validated.length; i++) {
    const number = i + 1;
    if (progress.submitted.includes(number)) continue;
    await submitAgentTasks(validated[i].value);
    progress.submitted.push(number);
    saveJson(progressPath, progress);
    console.log(JSON.stringify({ stage: stage.id, submittedChunk: number,
      count: validated[i].value.answers.length }));
  }
  const advanced = await advanceTargets(subjectsToTargets(items));
  saveJson(join(folder, "last-advance.json"), advanced);
  const remaining = await openTasks(stage.purposes);
  if (remaining.length === 0) {
    saveJson(join(folder, "merged.json"), { stage: stage.id, chunks: manifest.chunks.length,
      total: manifest.total, completedAt: new Date().toISOString() });
  }
  print({ execution: session, stage: stage.id, chunks: manifest.chunks.length,
    submitted: progress.submitted.length, stageCompleted: remaining.length === 0,
    pendingSameStage: remaining.length, next: remaining.length
      ? "prepare more chunks in the SAME stage"
      : "run verify to pass the stage quality gate before preparing the NEXT FIXED stage" });
}
async function verify(state: Execution) {
  const stage = currentStage(state);
  if (stage && existsSync(join(stageDir(state.stageIndex), "merged.json"))) {
    const folder = stageDir(state.stageIndex);
    const manifestPath = join(folder, "manifest.json");
    const manifest = existsSync(manifestPath) ? readJson<StageManifest>(manifestPath) : null;
    const ids = manifest?.chunks.flatMap(c =>
      readJson<AgentChunk>(join(folder, c.file)).items.map(item => item.id)) ?? [];
    const applied = ids.length ? await sql<{ id: string; status: string; superseded: boolean }[]>`
      SELECT t.id,t.status,EXISTS (
        SELECT 1 FROM agent_model_requests newer
        WHERE newer.purpose=t.purpose
          AND (newer.subject=t.subject OR
            (t.purpose='story_digest' AND split_part(newer.subject,'@',1)=split_part(t.subject,'@',1)))
          AND newer.status='applied' AND newer.created_at>t.created_at
      ) AS superseded FROM agent_model_requests t WHERE t.id = ANY(${ids}::text[])` : [];
    const unfinished = applied.filter(item => item.status !== "applied" &&
      !(item.status === "answered" && item.superseded));
    const stillPending = await openTasks(stage.purposes);
    if (unfinished.length || applied.length !== ids.length || stillPending.length) {
      throw new Error("Stage verification failed: " + stage.id +
        ", unapplied=" + (unfinished.length + ids.length - applied.length) +
        ", pending=" + stillPending.length);
    }
    if (!state.completedStages.includes(stage.id)) state.completedStages.push(stage.id);
    state.stageIndex++;
    saveJson(executionPath, state);
  }
  const pending = await globalPending();
  const metrics = await sql<{ selected: number; digested: number; hot: number; articles: number }[]>`
    SELECT (SELECT count(*)::int FROM publications WHERE selected AND visibility='public') selected,
      (SELECT count(*)::int FROM stories WHERE digest IS NOT NULL) digested,
      (SELECT coalesce(jsonb_array_length(entries),0) FROM hot_rankings
        WHERE published ORDER BY computed_at DESC LIMIT 1) hot,
      (SELECT count(*)::int FROM articles) articles`;
  const report = { execution: session, currentStage: currentStage(state)?.id ?? "completed",
    completedStages: state.completedStages, pending, metrics: metrics[0],
    ready: state.stageIndex === AIHOT_STAGES.length && pending.length === 0 };
  saveJson(join(home, "verification.json"), report);
  print(report);
}
try {
  if (action === "clean") {
    if (!args.includes("--dry-run") && !args.includes("--fresh"))
      throw new Error("Use --fresh to confirm clearing old temporary work, or --dry-run");
    print(sessionCleanup(session, { dryRun: args.includes("--dry-run") }));
  } else {
    if (action === "prepare" && args.includes("--fresh")) {
      const cleaned = sessionCleanup(session);
      if (!cleaned.success) throw new Error("Fresh run cleanup did not succeed");
    }
    const state = execution();
    if (action === "status") {
      print({ execution: session, runStartedAt: state.startedAt,
        currentStage: currentStage(state)?.id ?? "completed",
        completedStages: state.completedStages,
        legacyDirectoriesIgnored: "round-*",
        workspace: home });
    } else if (action === "prepare") await prepare(state);
    else if (action === "merge") await merge(state);
    else if (action === "verify") await verify(state);
    else if (action === "advance") print(await advanceAgentWorkflow({ limit: positive("limit", 30, 100) }));
    else if (action === "finish") {
      const pending = await globalPending();
      if (state.stageIndex !== AIHOT_STAGES.length || pending.length)
        throw new Error("Full execution has not passed every stage and final verification");
      if (!existsSync(join(home, "verification.json")) ||
          !readJson<{ ready: boolean }>(join(home, "verification.json")).ready)
        throw new Error("Final verification is required before cleanup");
      print({ completed: true, cleanup: sessionCleanup(session) });
    } else throw new Error("Usage: agent-workflow.ts status | prepare [--fresh] [--chunk-size N] | merge | verify | advance | finish | clean [--dry-run|--fresh] --session NAME");
  }
} finally { await closeDb(); }
