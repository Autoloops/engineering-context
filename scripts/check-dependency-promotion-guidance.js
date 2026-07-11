import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression guard for issue #79: the bootstrap/refresh prompts and skills
// must instruct the agent to promote externally-owned dependencies (a
// message broker, datastore, third-party API, build/deploy platform) to
// first-class components using the primitives that already exist
// (component + `about` + `touches`), and must do so generically - no fixed
// technology list, and no schema changes required for the fix to work.
//
// This does not (and cannot) prove an LLM will comply; see
// check-dependency-promotion-retrieval.js for proof that the mechanism the
// guidance teaches actually produces a retrievable first-class component
// when followed.

const root = new URL("..", import.meta.url);
const readDoc = (relativePath) => readFileSync(fileURLToPath(new URL(relativePath, root)), "utf8");

// The whole point of this fix is that it is generic. If any of these
// literal technology names creep back into the guidance, the fix has
// regressed into exactly the hardcoded-list approach that was rejected.
const forbiddenTechnologyNames = [
  "kafka",
  "docker",
  " ecs",
  "prisma",
  "clickhouse",
  "socket.io",
  "redis",
  "postgres",
  "rabbitmq",
];

function assertContainsAll(label, text, phrases) {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    assert.ok(lower.includes(phrase.toLowerCase()), `${label}: expected promotion guidance to mention "${phrase}"`);
  }
}

function assertNoHardcodedTechnologyNames(label, text) {
  const lower = text.toLowerCase();
  for (const name of forbiddenTechnologyNames) {
    assert.ok(
      !lower.includes(name),
      `${label}: guidance must stay generic - found hardcoded technology name "${name.trim()}"`,
    );
  }
}

// The two internal memory-build prompts share the same detailed criteria
// wording (load-bearing, multi-reference, queryable-by-name, generic
// judgment call) plus the connection mechanism and the contains anti-pattern.
function assertGuidancePresent(label, text) {
  assertContainsAll(label, text, [
    "promote",
    "externally owned",
    "operationally load-bearing",
    "graph context",
    "not a fixed technology list",
    "about",
    "touches",
    "code_anchor",
    "contains",
  ]);
  assertNoHardcodedTechnologyNames(label, text);
}

function assertSequentialHeadings(label, text) {
  const headings = [...text.matchAll(/^### (\d+)\. /gm)].map((match) => Number(match[1]));
  assert.ok(headings.length > 0, `${label}: expected numbered "### N. Title" workflow headings`);
  const expected = headings.map((_, index) => index + 1);
  assert.deepEqual(
    headings,
    expected,
    `${label}: workflow headings must be sequential with no gaps or duplicates, got ${JSON.stringify(headings)}`,
  );
}

// --- scripts/memory-build/prompts/deep-bootstrap.md ---
{
  const doc = readDoc("scripts/memory-build/prompts/deep-bootstrap.md");
  assert.match(doc, /### \d+\. Promote First-Class Dependencies/, "deep-bootstrap.md must have a promotion section");
  assertGuidancePresent("deep-bootstrap.md", doc);
  assertSequentialHeadings("deep-bootstrap.md", doc);
}

// --- scripts/memory-build/prompts/layered-deep-bootstrap.md ---
{
  const doc = readDoc("scripts/memory-build/prompts/layered-deep-bootstrap.md");
  assert.match(
    doc,
    /### \d+\. Promote First-Class Dependencies/,
    "layered-deep-bootstrap.md must have a promotion section",
  );
  assertGuidancePresent("layered-deep-bootstrap.md", doc);
  assertSequentialHeadings("layered-deep-bootstrap.md", doc);
  // The refresh variant is specifically about promoting from *existing*
  // claims that already named the dependency, without discarding them.
  assert.match(
    doc.toLowerCase(),
    /existing claims/,
    "layered-deep-bootstrap.md must instruct scanning existing claims for unpromoted dependencies",
  );
}

// --- skills/greplica-bootstrap/SKILL.md ---
// Condensed wording (not the detailed internal-prompt phrasing): still
// requires the same load-bearing/query-by-name criteria and connection
// mechanism, minus the internal prompts' "generic judgment call" sentence.
{
  const doc = readDoc("skills/greplica-bootstrap/SKILL.md");
  assertContainsAll("skills/greplica-bootstrap/SKILL.md", doc, [
    "does not own",
    "operationally load-bearing",
    "query it by name",
    "about",
    "code_anchor",
    "contains",
  ]);
  assertNoHardcodedTechnologyNames("skills/greplica-bootstrap/SKILL.md", doc);
}

// --- skills/greplica-fast-session-bootstrap/SKILL.md ---
// This skill only promotes dependencies the transcript bundle itself
// already raised - it must not encourage code-derived discovery.
{
  const doc = readDoc("skills/greplica-fast-session-bootstrap/SKILL.md");
  assertContainsAll("skills/greplica-fast-session-bootstrap/SKILL.md", doc, [
    "does not own",
    "about",
  ]);
  assert.match(
    doc.toLowerCase(),
    /do not go looking for dependencies in code/,
    "skills/greplica-fast-session-bootstrap/SKILL.md must scope promotion to bundle-raised dependencies, not code-derived discovery",
  );
  assertNoHardcodedTechnologyNames("skills/greplica-fast-session-bootstrap/SKILL.md", doc);
}

console.log("check-dependency-promotion-guidance: ok");
