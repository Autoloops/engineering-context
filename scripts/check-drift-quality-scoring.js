import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const rubric = JSON.parse(
  readFileSync(new URL("evals/cases/anchor-drift-quality/rubric.json", root), "utf8"),
);
const {
  buildJudgeCases,
  replacementClaimsFor,
  scoreQuality,
} = await import(new URL("dist/evals/lib/drift-quality-scoring.js", root));

const driftCases = rubric.cases.filter(({ action }) => action !== "leave");
const claims = [];
const edges = [];
for (const rubricCase of driftCases) {
  const replacement = {
    id: `replacement.${rubricCase.id}`,
    kind: "fact",
    text: rubricCase.expected,
    truth: "code_verified",
    intent: "intended",
    code_anchors: [{
      file: "fixture.ts",
      ...(rubricCase.expected_anchor_symbol === undefined
        ? {}
        : { symbol: rubricCase.expected_anchor_symbol }),
    }],
  };
  claims.push(replacement);
  edges.push({
    id: `edge.${rubricCase.id}`,
    from_id: replacement.id,
    from_type: "claim",
    to_id: rubricCase.id,
    to_type: "claim",
    kind: "supersedes",
  });
}
const perfectProposal = { creates: { claims, edges } };
const perfectJudge = {
  cases: driftCases.map(({ id }) => ({
    case_id: id,
    correctness: 1,
    completeness: 1,
    preservation: 1,
    reason: "Fixture-perfect replacement.",
  })),
};

const perfect = scoreQuality(rubric, perfectProposal, perfectJudge);
assert.equal(perfect.final_score, 100);
assert.equal(perfect.passed, true);
assert.ok(Number.isFinite(perfect.final_score));

const noRepair = scoreQuality(rubric, { creates: {} }, perfectJudge);
assert.equal(noRepair.passed, false);
assert.ok(noRepair.final_score < rubric.score.pass_threshold);
assert.ok(noRepair.final_score >= 0);

const trap = rubric.cases.find(({ action }) => action === "leave");
assert.ok(trap);
const damagedProposal = {
  creates: {
    claims: [...claims, {
      id: "replacement.trap",
      text: "Needlessly replaced a fresh claim.",
      code_anchors: [],
    }],
    edges: [...edges, {
      kind: "supersedes",
      from_id: "replacement.trap",
      to_id: trap.id,
    }],
  },
};
const damaged = scoreQuality(rubric, damagedProposal, perfectJudge);
assert.ok(damaged.final_score < perfect.final_score);
assert.equal(damaged.cases.find(({ id }) => id === trap.id).dimensions.restraint, 0);

const outOfRangeJudge = {
  cases: perfectJudge.cases.map((entry, index) => ({
    ...entry,
    correctness: index === 0 ? 2 : 1,
    completeness: index === 1 ? -1 : 1,
    preservation: index === 2 ? Number.NaN : 1,
  })),
};
const clamped = scoreQuality(rubric, perfectProposal, outOfRangeJudge);
assert.ok(Number.isFinite(clamped.final_score));
assert.ok(clamped.final_score >= 0 && clamped.final_score <= 100);

assert.throws(
  () => scoreQuality(rubric, perfectProposal, { cases: perfectJudge.cases.slice(1) }),
  /Judge output case IDs did not match the rubric/,
);
assert.throws(
  () => scoreQuality(rubric, perfectProposal, {
    cases: [...perfectJudge.cases, perfectJudge.cases[0]],
  }),
  /Judge output case IDs did not match the rubric/,
);

const firstCase = driftCases[0];
assert.equal(replacementClaimsFor(perfectProposal, firstCase.id).length, 1);
assert.deepEqual(
  buildJudgeCases(
    rubric,
    new Map(rubric.cases.map(({ id }) => [id, `Original ${id}`])),
    perfectProposal,
  ).map(({ case_id }) => case_id),
  driftCases.map(({ id }) => id),
);

console.log("Drift quality scoring checks passed.");
