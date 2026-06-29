// Focused smoke check for the Factory Droid install platform.
//
// Verifies that `greplica install --platform factory-droid` installs the bundled
// skills under ~/.factory/skills and registers UserPromptSubmit + Stop hooks in
// ~/.factory/hooks.json (both overridable via FACTORY_HOME), that the hook config
// is merged non-destructively, and that the platform exposes the same surfaces as
// the Codex/Claude installers (session refs, transcript projection).
//
// Run with: npm run smoke:factory-droid

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { droidInstaller } = await import("../dist/libs/install/platforms/droid.js");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

const factoryHome = mkdtempSync(join(tmpdir(), "greplica-droid-smoke-"));
const hooksPath = join(factoryHome, "hooks.json");
const skillsRoot = join(factoryHome, "skills");
const previousFactoryHome = process.env.FACTORY_HOME;
process.env.FACTORY_HOME = factoryHome;

try {
  // Seed an unrelated existing hook to confirm the merge is non-destructive.
  writeFileSync(
    hooksPath,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "echo keep-me" }] }] } }, null, 2),
    "utf8",
  );

  const result = droidInstaller.install();

  // Skills installed in the expected location.
  assert(result.skills.length > 0, "expected at least one skill to be installed");
  for (const skill of result.skills) {
    assert(skill.startsWith(skillsRoot), `skill not under ${skillsRoot}: ${skill}`);
    assert(existsSync(skill), `skill file missing: ${skill}`);
  }

  // Hooks registered for the expected events with the factory-droid command.
  assert(result.hooks !== undefined, "expected hooks to be installed");
  assert(result.hooks.configFiles.includes(hooksPath), `hooks config should be ${hooksPath}`);
  assert(result.hooks.events.includes("UserPromptSubmit"), "expected UserPromptSubmit hook event");
  assert(result.hooks.events.includes("Stop"), "expected Stop hook event");
  assert(
    result.hooks.command === "greplica hook ingest --platform factory-droid",
    `unexpected hook command: ${result.hooks.command}`,
  );

  const config = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert(Array.isArray(config.hooks.UserPromptSubmit), "hooks.json missing UserPromptSubmit");
  assert(Array.isArray(config.hooks.Stop), "hooks.json missing Stop");
  assert(Array.isArray(config.hooks.PreToolUse), "non-destructive merge lost the seeded PreToolUse hook");
  const serialized = JSON.stringify(config);
  assert(serialized.includes("greplica hook ingest --platform factory-droid"), "hooks.json missing greplica command");
  assert(serialized.includes("echo keep-me"), "seeded hook content was clobbered");

  // Session ref round-trips, matching the Codex/Claude installers.
  const ref = droidInstaller.sessionSourceRef("abc-123");
  assert(ref === "factory-droid-session:abc-123", `unexpected session ref: ${ref}`);
  assert(droidInstaller.sessionIdFromSourceRef(ref) === "abc-123", "session id did not round-trip");
  assert(droidInstaller.sessionIdFromSourceRef("codex-session:x") === undefined, "should not match other platform refs");

  // Transcript projection works on Claude-style JSONL (Droid's format).
  const md = droidInstaller.transcriptToMarkdown(
    [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } }),
    ].join("\n"),
  );
  assert(md.includes("hello") && md.includes("hi there"), "transcript projection dropped message text");

  console.log(`OK: Factory Droid skills + hooks installed under ${factoryHome}`);
} finally {
  if (previousFactoryHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = previousFactoryHome;
  rmSync(factoryHome, { recursive: true, force: true });
}
