import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readJson, repoRoot, run } from "./lib.js";

export interface ProposalManifest {
  apply_order: string[];
}

export function greplicaCommand(): string[] {
  return ["node", join(repoRoot, "dist/apps/cli/main.js")];
}

export function seedCodexRuntimeHome(codexHomeDir: string): void {
  const sourceHome = resolve(homedir(), ".codex");
  mkdirSync(codexHomeDir, { recursive: true });
  for (const file of ["auth.json", "config.toml", "models_cache.json", ".codex-global-state.json", "installation_id"]) {
    const source = resolve(sourceHome, file);
    if (existsSync(source)) copyFileSync(source, resolve(codexHomeDir, file));
  }
}

export function installGreplica(command: string[], checkoutDir: string, env: NodeJS.ProcessEnv): string {
  return run([...command, "install", "--platform", "codex", "--embedding", "local"], checkoutDir, env);
}

export function validateAndApplyManifest(input: {
  taskDir: string;
  checkoutDir: string;
  env: NodeJS.ProcessEnv;
  greplicaCommand: string[];
}): string[] {
  const manifest = readJson<ProposalManifest>(join(input.taskDir, "proposals", "manifest.json"));
  const output: string[] = [];
  for (const file of manifest.apply_order) {
    const proposalPath = join(input.taskDir, "proposals", file);
    output.push(run([...input.greplicaCommand, "proposal", "validate", proposalPath], input.checkoutDir, input.env));
    output.push(run([...input.greplicaCommand, "proposal", "apply", proposalPath], input.checkoutDir, input.env));
  }
  return output;
}
