// The Skill/Agent is the transport for the original model prompts.
// Examples: node --env-file=.env scripts/agent-tasks.ts export --limit 8 --out .data/agent-tasks/pending-001.json
//           node --env-file=.env scripts/agent-tasks.ts submit --file .data/agent-tasks/answers-001.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { agentBridgeStats, pendingAgentTasks, submitAgentTasks } from "@aihot/backend/providers/agent-bridge";
import { advanceAgentWorkflow, subjectsToTargets } from "./agent-advance.ts";

if (process.env.AGENT_REVIEW_ENABLED !== "true") throw new Error("Enable AGENT_REVIEW_ENABLED=true for Agent tasks");
const [action, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
async function consumeNow(answers: Array<{ id: string }>) {
  const ids = new Set(answers.map(x => x.id));
  const tasks = await sql<{ id: string; purpose: string; subject: string }[]>`
    SELECT id,purpose,subject FROM agent_model_requests WHERE id = ANY(${[...ids]}::text[])`;
  const targets = subjectsToTargets(tasks);
  const stages = [];
  for (let i = 0; i < targets.articleIds.length; i += 40) {
    stages.push(await advanceAgentWorkflow({ articleIds: targets.articleIds.slice(i, i + 40), limit: 40, includeScheduled: false }));
  }
  const scheduled = await advanceAgentWorkflow({ articleIds: [], storyIds: targets.storyIds, limit: 40 });
  return { stages, scheduled };
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
    const advanced = await consumeNow(answers.answers);
    console.log(JSON.stringify({ answered: count, directAdvance: advanced }));
  } else if (action === "stats") {
    console.log(JSON.stringify(await agentBridgeStats(), null, 2));
  } else throw new Error("Usage: agent-tasks.ts export [--limit N] [--out FILE] | submit --file FILE | stats");
} finally {
  await closeDb();
}
