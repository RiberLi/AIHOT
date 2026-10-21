// The Skill/Agent is the transport for the original model prompts.
// Examples: node --env-file=.env scripts/agent-tasks.ts export --limit 8 --out .data/agent-tasks/pending-001.json
//           node --env-file=.env scripts/agent-tasks.ts submit --file .data/agent-tasks/answers-001.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeDb } from "@aihot/backend/db";
import { stopBoss, enqueue, QUEUES } from "@aihot/backend/jobs/queue";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { agentBridgeStats, pendingAgentTasks, submitAgentTasks } from "@aihot/backend/providers/agent-bridge";

if (process.env.AGENT_REVIEW_ENABLED !== "true") throw new Error("Enable AGENT_REVIEW_ENABLED=true for Agent tasks");
const [action, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
let bossStarted = false;
async function resume(answers: Array<{ id: string }>) {
  const ids = new Set(answers.map(x => x.id));
  const tasks = await (await import("@aihot/backend/db")).sql<{ id: string; purpose: string; subject: string }[]>`
    SELECT id,purpose,subject FROM agent_model_requests WHERE id = ANY(${[...ids]}::text[])`;
  const enqueued = new Set<string>();
  for (const task of tasks) {
    const article = /^article:([^@:#]+)/.exec(task.subject)?.[1];
    if (article && (task.purpose.includes("_article") || task.purpose.startsWith("summarize_") || task.purpose === "mend_wording")) {
      if (!enqueued.has("a:" + article)) {
        bossStarted = true;
        await queueProcessing(article, { step: "analyze" });
        enqueued.add("a:" + article);
      }
    } else if (article && task.purpose.startsWith("group_")) {
      if (!enqueued.has("g:" + article)) {
        bossStarted = true;
        await enqueue(QUEUES.group, { articleId: article }, { singletonKey: article });
        enqueued.add("g:" + article);
      }
    } else if (task.purpose === "story_digest") {
      const story = /^story:(\d+)/.exec(task.subject)?.[1];
      if (story && !enqueued.has("d:" + story)) {
        bossStarted = true;
        await enqueue(QUEUES.digest, { storyId: Number(story) }, { singletonKey: "story:" + story });
        enqueued.add("d:" + story);
      }
    }
    // Translations retry every 5 minutes; weekly/monthly reports retry every
    // 30 minutes; story consolidations are retried by the scheduled story links.
  }
  return [...enqueued];
}

try {
  if (action === "export") {
    const tasks = await pendingAgentTasks(Number(flag("limit") ?? 8));
    const output = { schemaVersion: 1, items: tasks.map(t => ({
      id: t.id, purpose: t.purpose, subject: t.subject, promptVersion: t.prompt_version,
      status: t.status, error: t.error, request: t.request,
    })) };
    const target = flag("out");
    if (target) {
      const file = resolve(target);
      if (existsSync(file)) throw new Error("Export file already exists: " + file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(output, null, 2) + "\n", { flag: "wx", encoding: "utf8" });
      console.log(JSON.stringify({ exported: tasks.length, path: file }));
    } else console.log(JSON.stringify(output, null, 2));
  } else if (action === "submit") {
    const input = flag("file");
    if (!input) throw new Error("Missing --file answers.json");
    const answers = JSON.parse(readFileSync(resolve(input), "utf8"));
    const count = await submitAgentTasks(answers);
    const enqueued = await resume(answers.answers);
    console.log(JSON.stringify({ answered: count, requeued: enqueued }));
  } else if (action === "stats") {
    console.log(JSON.stringify(await agentBridgeStats(), null, 2));
  } else throw new Error("Usage: agent-tasks.ts export [--limit N] [--out FILE] | submit --file FILE | stats");
} finally {
  if (bossStarted) await stopBoss();
  await closeDb();
}
