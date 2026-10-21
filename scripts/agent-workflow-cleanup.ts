// Temporary session cleanup, mirroring codegraph-project CG0/S13.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeSessionName } from "./agent-workflow-lib.ts";

export type CleanupResult = {
  success: boolean;
  dryRun: boolean;
  target: string;
  removed: string[];
  remaining: number;
};

function rejectLinkedPath(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Refusing symlinked cleanup path: " + path);
  }
}

export function sessionCleanup(session: string, options: { dryRun?: boolean; cwd?: string } = {}): CleanupResult {
  const name = safeSessionName(session);
  const project = resolve(options.cwd ?? process.cwd());
  const parent = join(project, ".data", "agent-workflow");
  const target = join(parent, name);
  if (target !== resolve(parent, name)) throw new Error("Session path escaped workflow directory");
  rejectLinkedPath(join(project, ".data"));
  rejectLinkedPath(parent);
  rejectLinkedPath(target);
  if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error("Session target is not a directory");
  const removed = existsSync(target) ? readdirSync(target).sort() : [];
  if (!options.dryRun) {
    mkdirSync(target, { recursive: true });
    for (const entry of removed) rmSync(join(target, entry), { recursive: true, force: false });
  }
  const remaining = existsSync(target) ? readdirSync(target).length : 0;
  return { success: Boolean(options.dryRun) || remaining === 0,
    dryRun: Boolean(options.dryRun), target, removed, remaining };
}
