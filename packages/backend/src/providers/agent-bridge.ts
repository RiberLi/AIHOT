// Durable handoff at the ONE model interface. The Agent supplies model answers;
// the original article, grouping, translation and report code handles every business write.
import { z } from "zod";
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { paidRequest, ReceiptBusyError } from "./receipts.ts";
import type { ChatJsonOptions, ChatJsonResult } from "./llm.ts";

export function agentTaskId(input: Pick<ChatJsonOptions<z.ZodType>, "model" | "purpose" | "subject" | "promptVersion" | "system" | "user" | "attemptTag" | "temperature" | "maxTokens" | "json">): string {
  // Media discovery can add/remove a non-semantic image-count line without
  // bumping the article revision. Text-only Agent prompts must not demand a
  // second answer just because the image count changed. Keep actual image
  // ContentPart[] untouched: pixels can materially change the judgement.
  const user = typeof input.user === "string"
    ? input.user.replace(/【媒体】\d+ 张图(?:\\n|\r?\n)/g, "")
    : input.user;
  return sha256(stableJson({
    purpose: input.purpose, subject: input.subject, promptVersion: input.promptVersion,
    model: input.model, system: input.system, user, attemptTag: input.attemptTag ?? null,
    temperature: input.temperature ?? null, maxTokens: input.maxTokens ?? null, json: input.json ?? null,
  }));
}

interface AgentTaskRow {
  id: string;
  purpose: string;
  subject: string;
  prompt_version: string;
  request: { system: string; user: unknown; modelCapability: string; expectedOutput: string; jsonSchema?: unknown };
  response: { data?: unknown; text?: string } | null;
  status: "pending" | "answered" | "invalid" | "applied";
  error: string | null;
}

/** This replaces the transport only. No API key, provider credentials or billing. */
export async function agentChatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const id = agentTaskId(opts);
  let jsonSchema: unknown = null;
  try {
    // Give the reviewing Agent the same output field contract enforced by the
    // engine. Refinements are still checked by opts.schema.parse below.
    jsonSchema = z.toJSONSchema(opts.schema, { unrepresentable: "any" });
  } catch {
    // Some transforms/refinements do not have a JSON Schema representation.
    // The original Zod validator remains authoritative on every replay.
  }
  const request = {
    modelCapability: opts.model,
    temperature: opts.temperature ?? null,
    maxTokens: opts.maxTokens ?? null,
    system: opts.system,
    user: opts.user,
    expectedOutput: opts.parse ? "text (parsed by the original pipeline)" : "JSON object (validated by the original pipeline)",
    jsonSchema,
  };
  const [task] = await sql<Pick<AgentTaskRow, "status" | "response">[]>`
    INSERT INTO agent_model_requests (id,purpose,subject,prompt_version,request)
    VALUES (${id},${opts.purpose},${opts.subject},${opts.promptVersion},${sql.json(request as never)})
    ON CONFLICT (id) DO UPDATE SET request = CASE
      WHEN agent_model_requests.status IN ('pending','invalid') THEN EXCLUDED.request
      ELSE agent_model_requests.request END
    RETURNING status,response`;
  if (!task || (task.status !== "answered" && task.status !== "applied") || !task.response) {
    throw new ReceiptBusyError("Agent answer pending: " + id.slice(0, 12));
  }
  let parsed: z.infer<S>;
  try {
    const data = task.response.text === undefined ? task.response.data : opts.parse ? opts.parse(task.response.text) : JSON.parse(task.response.text);
    parsed = opts.schema.parse(data);
  } catch (error) {
    await sql`UPDATE agent_model_requests SET status='invalid', error=${String(error).slice(0, 1200)}
      WHERE id=${id} AND status='answered'`;
    throw new ReceiptBusyError("Agent output fails original model schema: " + id.slice(0, 12));
  }
  const receipt = await paidRequest(
    {
      service: "agent",
      model: "local-skill",
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { taskId: id, promptVersion: opts.promptVersion },
      requestSummary: { taskId: id, executor: "agent-skill", promptVersion: opts.promptVersion },
      attemptTag: opts.attemptTag,
    },
    async () => ({
      response: { choices: [{ message: { content: JSON.stringify(parsed) }, finish_reason: "stop" }], model: "local-skill" },
      requestId: id,
      usage: null,
      cost: { amount: 0, currency: "USD", basis: "actual" as const },
    }),
  );
  await sql`UPDATE agent_model_requests SET status='applied', applied_at=now(), error=NULL WHERE id=${id} AND status='answered'`;
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: "local-skill", usage: null };
}

export async function pendingAgentTasks(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error("limit 1..40 required");
  return sql<AgentTaskRow[]>`SELECT id,purpose,subject,prompt_version,request,response,status,error
    FROM agent_model_requests WHERE status IN ('pending','invalid')
    ORDER BY created_at,id LIMIT ${limit}`;
}

export async function submitAgentTasks(batch: unknown) {
  const { z } = await import("zod");
  const input = z.object({ answers: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    data: z.unknown().optional(),
    text: z.string().optional(),
  }).strict().refine(x => (x.data !== undefined) !== (x.text !== undefined), "Provide exactly one of data/text")).min(1).max(40) }).strict().parse(batch);
  if (new Set(input.answers.map(x => x.id)).size !== input.answers.length) throw new Error("Duplicate task id");
  return sql.begin(async tx => {
    for (const answer of input.answers) {
      const [row] = await tx<{ status: AgentTaskRow["status"]; response: unknown }[]>`
        SELECT status,response FROM agent_model_requests WHERE id=${answer.id} FOR UPDATE`;
      if (!row) throw new Error("Unknown task " + answer.id);
      const response = answer.text !== undefined ? { text: answer.text } : { data: answer.data };
      if (row.status === "answered" || row.status === "applied") {
        if (stableJson(row.response) !== stableJson(response)) throw new Error("Already answered " + answer.id);
        continue;
      }
      await tx`UPDATE agent_model_requests SET status='answered',response=${tx.json(response as never)},
        error=NULL,answered_at=now() WHERE id=${answer.id}`;
    }
    return input.answers.length;
  });
}

export async function agentBridgeStats() {
  const rows = await sql<{ status: string; n: number }[]>`
    SELECT status,count(*)::int AS n FROM agent_model_requests GROUP BY status`;
  return Object.fromEntries(rows.map(x => [x.status,x.n]));
}
