// Pure validation helpers for the AIHOT prepare -> AI chunks -> merge workflow.
export type AgentChunkTask = {
  id: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  status: "pending" | "invalid";
  error: string | null;
  request: {
    system: string;
    user: unknown;
    jsonSchema?: unknown;
    expectedOutput: string;
    modelCapability: string;
  };
};

export type AgentChunk = {
  session: string;
  round?: number; // Readable only for legacy exports; new runs use fixed stage.
  stage?: string;
  chunk: number;
  items: AgentChunkTask[];
};

export type AgentAnswer = { id: string; data?: unknown; text?: string };

export function validateAgentChunk(chunk: AgentChunk, value: unknown): { answers: AgentAnswer[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected {answers:[...]}");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).join(",") !== "answers" || !Array.isArray(obj.answers)) {
    throw new Error("Chunk output must contain only answers array");
  }
  const answers = obj.answers as unknown[];
  if (answers.length !== chunk.items.length) throw new Error("Chunk answer count must match input count");
  const wanted = new Map(chunk.items.map(t => [t.id, t]));
  const seen = new Set<string>();
  for (const unknownAnswer of answers) {
    if (!unknownAnswer || typeof unknownAnswer !== "object" || Array.isArray(unknownAnswer)) throw new Error("Invalid answer object");
    const answer = unknownAnswer as Record<string, unknown>;
    if (typeof answer.id !== "string" || !wanted.has(answer.id) || seen.has(answer.id)) {
      throw new Error("Missing/extra/duplicate task ID " + String(answer.id));
    }
    seen.add(answer.id);
    const keys = Object.keys(answer);
    if (keys.some(k => !["id", "data", "text"].includes(k))) throw new Error("Unexpected answer key");
    const hasData = Object.hasOwn(answer, "data") && answer.data !== undefined;
    const hasText = Object.hasOwn(answer, "text");
    if (hasData === hasText) throw new Error("Exactly one of data or text required");
    if (hasText && (typeof answer.text !== "string" || !answer.text.trim())) throw new Error("Empty text answer");
    if (hasData && (answer.data === null || typeof answer.data !== "object" || Array.isArray(answer.data))) {
      throw new Error("JSON data must be an object");
    }
    const task = wanted.get(answer.id)!;
    if (task.purpose === "score_article") {
      const score = (answer.data as Record<string, unknown>)?.attentionScore;
      if (typeof score !== "number" || score < 0 || score > 100) throw new Error("Score must be 0..100");
    }
  }
  return { answers: answers as AgentAnswer[] };
}

export function partitionTasks<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error("chunk size must be 1..20");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function safeSessionName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$/.test(value)) throw new Error("Invalid session name");
  return value;
}
