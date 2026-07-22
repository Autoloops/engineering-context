import { homedir } from "node:os";
import { join } from "node:path";

export type GreplicaHomeSource = "GREPLICA_HOME" | "ENGINEERING_CONTEXT_HOME" | "default";

export interface ResolvedGreplicaHome {
  path: string;
  source: GreplicaHomeSource;
}

export function resolveGreplicaHome(env: NodeJS.ProcessEnv = process.env): ResolvedGreplicaHome {
  if (env.GREPLICA_HOME !== undefined && env.GREPLICA_HOME.length > 0) {
    return { path: env.GREPLICA_HOME, source: "GREPLICA_HOME" };
  }
  if (env.ENGINEERING_CONTEXT_HOME !== undefined && env.ENGINEERING_CONTEXT_HOME.length > 0) {
    return { path: env.ENGINEERING_CONTEXT_HOME, source: "ENGINEERING_CONTEXT_HOME" };
  }
  return { path: join(homedir(), ".greplica"), source: "default" };
}

export function greplicaHome(): string {
  return resolveGreplicaHome().path;
}
