// Focused smoke check for the Cursor install platform.
//
// Verifies that the Cursor installer copies the bundled skills under
// ~/.cursor/skills, writes a non-destructive project rule at
// <repo>/.cursor/rules/greplica.mdc (falling back to greplica-N.mdc when a
// user-authored rule exists), and merges beforeSubmitPrompt + stop hooks into
// ~/.cursor/hooks.json without disturbing existing hooks. CURSOR_HOME overrides
// the ~/.cursor location for isolation.
//
// Run with: npm run smoke:cursor

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { cursorInstaller } = await import("../dist/libs/install/platforms/cursor.js");
const { hookCwd, hookSessionId, hookEventName } = await import("../dist/libs/hooks/hook-input.js");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

const cursorHome = mkdtempSync(join(tmpdir(), "greplica-cursor-home-"));
const skillsRoot = join(cursorHome, "skills");
const hooksPath = join(cursorHome, "hooks.json");
const repoA = mkdtempSync(join(tmpdir(), "greplica-cursor-repoA-"));
const repoB = mkdtempSync(join(tmpdir(), "greplica-cursor-repoB-"));
const previousCursorHome = process.env.CURSOR_HOME;
process.env.CURSOR_HOME = cursorHome;

const hookCommand = "greplica hook ingest --platform cursor";

try {
  // Seed an unrelated existing hook to confirm the merge is non-destructive.
  writeFileSync(
    hooksPath,
    JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "keep-me.sh" }] } }, null, 2),
    "utf8",
  );

  // --- Install into repoA with hooks ---
  const result = cursorInstaller.install({ repoRoot: repoA, hooks: true });

  // Skills installed under the user-scoped ~/.cursor/skills directory.
  assert(result.skills.length > 0, "expected at least one skill to be installed");
  for (const skill of result.skills) {
    assert(skill.startsWith(skillsRoot), `skill not under ${skillsRoot}: ${skill}`);
    assert(existsSync(skill), `skill file missing: ${skill}`);
  }

  // Project rule written with the expected guidance content.
  assert(result.rules !== undefined, "expected a project rule to be installed");
  const rulePath = join(repoA, ".cursor", "rules", "greplica.mdc");
  assert(result.rules.configFiles[0] === rulePath, `unexpected rule path: ${result.rules.configFiles[0]}`);
  const rule = readFileSync(rulePath, "utf8");
  assert(rule.includes("alwaysApply: true"), "rule missing alwaysApply");
  assert(rule.includes("greplica graph context"), "rule missing graph context guidance");
  assert(rule.includes("greplica-bootstrap") && rule.includes("greplica-update-working-memory"), "rule missing skill references");

  // Hooks merged into ~/.cursor/hooks.json with the expected events + command.
  assert(result.hooks !== undefined, "expected hooks to be installed");
  assert(result.hooks.configFiles.includes(hooksPath), `hooks config should be ${hooksPath}`);
  assert(result.hooks.events.includes("beforeSubmitPrompt"), "expected beforeSubmitPrompt hook event");
  assert(result.hooks.events.includes("stop"), "expected stop hook event");
  assert(result.hooks.command === hookCommand, `unexpected hook command: ${result.hooks.command}`);

  const config = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert(Array.isArray(config.hooks.beforeSubmitPrompt), "hooks.json missing beforeSubmitPrompt");
  assert(Array.isArray(config.hooks.stop), "hooks.json missing stop");
  assert(Array.isArray(config.hooks.afterFileEdit), "non-destructive merge lost the seeded afterFileEdit hook");
  const serialized = JSON.stringify(config);
  assert(serialized.includes(hookCommand), "hooks.json missing greplica command");
  assert(serialized.includes("keep-me.sh"), "seeded hook content was clobbered");

  // Re-install is idempotent: no duplicate command, no duplicate rule file.
  cursorInstaller.install({ repoRoot: repoA, hooks: true });
  const reconfig = JSON.parse(readFileSync(hooksPath, "utf8"));
  const ours = reconfig.hooks.beforeSubmitPrompt.filter((handler) => handler.command === hookCommand);
  assert(ours.length === 1, "re-install duplicated the beforeSubmitPrompt command");
  assert(!existsSync(join(repoA, ".cursor", "rules", "greplica-1.mdc")), "re-install created a duplicate rule file");

  // Non-destructive rule: a user-authored greplica.mdc is preserved; we fall back.
  const rulesDirB = join(repoB, ".cursor", "rules");
  mkdirSync(rulesDirB, { recursive: true });
  const userRule = join(rulesDirB, "greplica.mdc");
  writeFileSync(userRule, "my own cursor rule\n", "utf8");
  const resultB = cursorInstaller.install({ repoRoot: repoB, hooks: false });
  assert(readFileSync(userRule, "utf8") === "my own cursor rule\n", "user-authored rule was overwritten");
  assert(resultB.rules.configFiles[0] === join(rulesDirB, "greplica-1.mdc"), "expected fallback greplica-1.mdc");
  assert(readFileSync(resultB.rules.configFiles[0], "utf8").includes("Generated by Greplica"), "fallback rule missing marker");

  // If the user-authored preferred rule is later removed, reuse the generated
  // fallback instead of creating a second always-applied Greplica rule.
  rmSync(userRule);
  const resultBAgain = cursorInstaller.install({ repoRoot: repoB, hooks: false });
  assert(resultBAgain.rules.configFiles[0] === join(rulesDirB, "greplica-1.mdc"), "expected generated fallback to be reused");
  assert(!existsSync(userRule), "re-install created a duplicate preferred rule");

  // Install without hooks writes no hook config.
  assert(resultB.hooks === undefined, "hooks should not be installed when hooks=false");

  // Session ref round-trips, matching the other installers.
  const ref = cursorInstaller.sessionSourceRef("conv-1");
  assert(ref === "cursor-session:conv-1", `unexpected session ref: ${ref}`);
  assert(cursorInstaller.sessionIdFromSourceRef(ref) === "conv-1", "session id did not round-trip");
  assert(cursorInstaller.sessionIdFromSourceRef("codex-session:x") === undefined, "should not match other platform refs");

  // Cursor hook input mapping: conversation_id -> session id, beforeSubmitPrompt/stop
  // normalized to canonical events, and the Windows "/c:/..." workspace root
  // (URI-style, leading slash) resolved to a real filesystem path.
  const cursorHook = {
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: "conv-xyz",
    workspace_roots: ["/c:/Users/dev/project"],
  };
  assert(hookSessionId(cursorHook) === "conv-xyz", "conversation_id should map to session id");
  assert(hookEventName(cursorHook) === "UserPromptSubmit", "beforeSubmitPrompt should normalize to UserPromptSubmit");
  assert(hookEventName({ hook_event_name: "stop" }) === "Stop", "stop should normalize to Stop");
  assert(hookCwd(cursorHook) === "c:/Users/dev/project", "leading slash should be stripped from Windows workspace root");
  assert(hookCwd({ workspace_roots: ["/home/dev/project"] }) === "/home/dev/project", "unix workspace root should be unchanged");

  // Transcript projection: Cursor's { role, message: { content: [...] } } JSONL
  // maps to human/agent Markdown; control lines (turn_ended) are skipped.
  const md = cursorInstaller.transcriptToMarkdown(
    [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<system_instruction>ignore me</system_instruction>hello there" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "hi back" }, { type: "tool_use", name: "Shell", input: {} }] } }),
      JSON.stringify({ type: "turn_ended", status: "completed" }),
    ].join("\n"),
  );
  assert(md.includes("hello there") && md.includes("hi back"), "transcript projection dropped message text");
  assert(md.includes("### human") && md.includes("### agent"), "transcript projection did not label roles");
  assert(!md.includes("ignore me"), "transcript projection retained embedded system instructions");
  assert(!md.includes("tool_use") && !md.includes("turn_ended"), "transcript projection retained tool or control content");

  console.log(`OK: Cursor skills + rule + hooks installed (home=${cursorHome})`);
} finally {
  if (previousCursorHome === undefined) delete process.env.CURSOR_HOME;
  else process.env.CURSOR_HOME = previousCursorHome;
  rmSync(cursorHome, { recursive: true, force: true });
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
}
