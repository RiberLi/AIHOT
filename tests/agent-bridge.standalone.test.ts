import test from "node:test";
import assert from "node:assert/strict";
import { agentTaskId } from "../packages/backend/src/providers/agent-bridge.ts";
import { migrationPlan } from "../scripts/migration-safety.ts";
import { readFileSync } from "node:fs";
const base = {
  model: "default", purpose: "score_article", subject: "article:fixture@1",
  promptVersion: "v1", system: "Rate this story", user: "Evidence only",
  temperature: 0.2, maxTokens: 800,
};
test("agent task IDs are stable and separate both independent scoring calls", () => {
  const first = agentTaskId({ ...base, attemptTag: "score-1" });
  assert.equal(first, agentTaskId({ ...base, attemptTag: "score-1" }));
  assert.notEqual(first, agentTaskId({ ...base, attemptTag: "score-2" }));
  assert.notEqual(first, agentTaskId({ ...base, attemptTag: "score-1", promptVersion: "v2" }));
});
test("changed revision, content, model route or generation parameters cannot reuse stale Agent output", () => {
  const key = agentTaskId(base);
  for (const changed of [
    { subject: "article:fixture@2" }, { user: "Updated evidence" },
    { model: "different" }, { temperature: 0.4 }, { maxTokens: 900 },
  ]) assert.notEqual(key, agentTaskId({ ...base, ...changed }));
});
test("new agent task table uses an approved online migration", () => {
  const sql = readFileSync(new URL("../database/migrations/0090_agent_model_requests.sql", import.meta.url), "utf8");
  assert.equal(migrationPlan(sql).kind, "transaction");
});
