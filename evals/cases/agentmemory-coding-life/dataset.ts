import { resolve } from "node:path";
import { readJson } from "../../lib/common.js";

export interface Session {
  id: string;
  timestamp?: string;
  content: string;
}

export interface Query {
  id: string;
  type: string;
  question: string;
  answer: string;
  goldSessionIds: string[];
}

export function datasetDir(repoRoot: string): string {
  return resolve(repoRoot, "evals/cases/agentmemory-coding-life/data");
}

export function loadSessions(repoRoot: string): Session[] {
  return readJson<Session[]>(resolve(datasetDir(repoRoot), "sessions.json"));
}

export function loadQueries(repoRoot: string): Query[] {
  return readJson<Query[]>(resolve(datasetDir(repoRoot), "queries.json"));
}
