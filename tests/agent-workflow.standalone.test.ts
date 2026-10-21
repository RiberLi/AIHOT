import test from "node:test";
import assert from "node:assert/strict";
import { partitionTasks, safeSessionName, validateAgentChunk, type AgentChunk } from "../scripts/agent-workflow-lib.ts";
import { sessionCleanup } from "../scripts/agent-workflow-cleanup.ts";
import { AIHOT_STAGES, nextChunkName, nextStageForPending, stageIndexForPurpose } from "../scripts/agent-workflow-stages.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ids = ["a".repeat(64), "b".repeat(64)];
const chunk: AgentChunk = {
  session: "test", round: 1, chunk: 1,
  items: [
    { id: ids[0], purpose: "score_article", subject: "article:test@1", promptVersion: "v1", status: "pending", error: null,
      request: { system: "Score", user: "Evidence", modelCapability: "default", expectedOutput: "JSON object" } },
    { id: ids[1], purpose: "prefilter_article", subject: "article:test2@1", promptVersion: "v1", status: "pending", error: null,
      request: { system: "Filter", user: "Evidence", modelCapability: "default", expectedOutput: "JSON object" } },
  ],
};
const answers = [
  { id: ids[0], data: { attentionScore: 75 } },
  { id: ids[1], data: { label: "PASS", reason: "Relevant" } },
];
test("workflow partitions input and preserves every item", () => {
  assert.deepEqual(partitionTasks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => partitionTasks([1], 0));
  assert.throws(() => partitionTasks([1], 21));
});
test("one execution has fixed ordered business stages; chunks never create stages", () => {
  assert.deepEqual(AIHOT_STAGES.map(s => s.id), [
    "A1-prefilter", "A2-analysis", "A3-editorial", "A4-grouping", "A5-digest", "A6-report",
  ]);
  assert.equal(stageIndexForPurpose("score_article"), stageIndexForPurpose("structure_article"));
  assert.equal(stageIndexForPurpose("understand_article"), 2);
  assert.equal(nextStageForPending(["story_digest", "score_article"]), 1);
  assert.equal(nextStageForPending([]), AIHOT_STAGES.length);
  assert.equal(nextChunkName(1), "chunk-001");
  assert.equal(nextChunkName(100), "chunk-100");
  assert.throws(() => nextStageForPending(["unhandled_purpose"]));
});
test("workflow accepts complete answers in any order", () => {
  assert.equal(validateAgentChunk(chunk, { answers: answers.toReversed() }).answers.length, 2);
});
test("workflow rejects missing, extra, duplicate task IDs before any database write", () => {
  assert.throws(() => validateAgentChunk(chunk, { answers: [answers[0]] }), /count/);
  assert.throws(() => validateAgentChunk(chunk, { answers: [answers[0], answers[0]] }), /duplicate/);
  assert.throws(() => validateAgentChunk(chunk, { answers: [answers[0], { ...answers[1], id: "z".repeat(64) }] }), /task ID/);
});
test("workflow rejects malformed payload and implausible scores", () => {
  assert.throws(() => validateAgentChunk(chunk, { answers: [ { id: ids[0], data: { attentionScore: 101 } }, answers[1] ] }), /Score/);
  assert.throws(() => validateAgentChunk(chunk, { answers: [ { ...answers[0], text: "x" }, answers[1] ] }), /one/);
  assert.throws(() => validateAgentChunk(chunk, { answers: [{ ...answers[0], extra: true }, answers[1]] }), /Unexpected/);
});
test("workflow does not permit path traversal in session names", () => {
  assert.equal(safeSessionName("batch-2026_10"), "batch-2026_10");
  for (const session of ["../other", "x/y", "..", "", "\\windows"]) assert.throws(() => safeSessionName(session));
});
test("CodeGraph-style cleanup previews, removes only the requested session, and preserves the directory", () => {
  const root = mkdtempSync(join(tmpdir(), "aihot-clean-"));
  try {
    const a = join(root, ".data", "agent-workflow", "ai-session");
    const b = join(root, ".data", "agent-workflow", "other-session");
    mkdirSync(join(a, "round-001"), { recursive: true });
    mkdirSync(b);
    writeFileSync(join(a, "round-001", "manifest.json"), "{}", "utf8");
    writeFileSync(join(b, "must-stay.txt"), "saved", "utf8");
    const preview = sessionCleanup("ai-session", { cwd: root, dryRun: true });
    assert.equal(preview.removed[0], "round-001");
    assert.equal(existsSync(join(a, "round-001", "manifest.json")), true);
    const done = sessionCleanup("ai-session", { cwd: root });
    assert.equal(done.success, true);
    assert.deepEqual(readdirSync(a), []);
    assert.equal(existsSync(join(b, "must-stay.txt")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("CodeGraph-style cleanup rejects linked directories and escaping names", () => {
  const root = mkdtempSync(join(tmpdir(), "aihot-safe-"));
  try {
    assert.throws(() => sessionCleanup("../danger", { cwd: root }), /Invalid session/);
    mkdirSync(join(root, ".data", "agent-workflow"), { recursive: true });
    const other = join(root, "other");
    mkdirSync(other);
    symlinkSync(other, join(root, ".data", "agent-workflow", "ai-session"), "junction");
    assert.throws(() => sessionCleanup("ai-session", { cwd: root }), /symlink/i);
    assert.equal(existsSync(other), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
