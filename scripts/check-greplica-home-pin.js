import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const savedHome = process.env.GREPLICA_HOME;
const savedEngineering = process.env.ENGINEERING_CONTEXT_HOME;

try {
  delete process.env.GREPLICA_HOME;
  delete process.env.ENGINEERING_CONTEXT_HOME;

  const { resolveGreplicaHome, greplicaHome } = await import(new URL("dist/libs/config/greplica-home.js", root));
  const { hookWorkerChildEnv } = await import(new URL("dist/libs/hooks/worker.js", root));

  const defaultResolved = resolveGreplicaHome();
  assert.equal(defaultResolved.source, "default");
  assert.equal(defaultResolved.path, join(homedir(), ".greplica"));
  assert.equal(greplicaHome(), defaultResolved.path);

  process.env.ENGINEERING_CONTEXT_HOME = "/tmp/engineering-context-home-pin-test";
  const engineeringResolved = resolveGreplicaHome();
  assert.equal(engineeringResolved.source, "ENGINEERING_CONTEXT_HOME");
  assert.equal(engineeringResolved.path, "/tmp/engineering-context-home-pin-test");
  assert.equal(greplicaHome(), engineeringResolved.path);

  process.env.GREPLICA_HOME = "/tmp/greplica-home-pin-test";
  const envResolved = resolveGreplicaHome();
  assert.equal(envResolved.source, "GREPLICA_HOME");
  assert.equal(envResolved.path, "/tmp/greplica-home-pin-test");
  assert.equal(greplicaHome(), envResolved.path);

  const childEnv = hookWorkerChildEnv();
  assert.equal(childEnv.GREPLICA_HOME, "/tmp/greplica-home-pin-test");
  assert.equal(childEnv.GREPLICA_HOME, resolveGreplicaHome().path);

  // Partial base env (no GREPLICA_HOME) must still pin the parent's resolved home.
  const strippedChildEnv = hookWorkerChildEnv({ PATH: "/usr/bin" });
  assert.equal(strippedChildEnv.GREPLICA_HOME, "/tmp/greplica-home-pin-test");
  assert.equal(strippedChildEnv.PATH, "/usr/bin");

  console.log("check-greplica-home-pin: ok");
} finally {
  if (savedHome === undefined) delete process.env.GREPLICA_HOME;
  else process.env.GREPLICA_HOME = savedHome;
  if (savedEngineering === undefined) delete process.env.ENGINEERING_CONTEXT_HOME;
  else process.env.ENGINEERING_CONTEXT_HOME = savedEngineering;
}
