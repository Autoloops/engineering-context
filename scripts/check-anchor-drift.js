import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
let CodeAnchorResolver;
let fingerprintClaimAnchors;
let auditClaimCodeAnchors;

beforeAll(async () => {
  const resolver = await import(new URL("dist/libs/knowledge-graph/code-anchors/resolver.js", root));
  const fingerprint = await import(new URL("dist/libs/knowledge-graph/code-anchors/fingerprint.js", root));
  const audit = await import(new URL("dist/libs/knowledge-graph/code-anchors/audit.js", root));
  CodeAnchorResolver = resolver.CodeAnchorResolver;
  fingerprintClaimAnchors = fingerprint.fingerprintClaimAnchors;
  auditClaimCodeAnchors = audit.auditClaimCodeAnchors;
});

describe("anchor drift", () => {
  test("unchanged code does not drift", async () => {
    const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
    const file = join(repo, "mod.py");
    const anchor = { file: "mod.py", symbol: "foo" };
    const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

    writeFileSync(file, "def foo():\n    # returns the threshold\n    return 3\n");
    const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

    async function driftedIds(variant) {
      writeFileSync(file, variant);
      const result = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver(), baseline);
      return result.drifted.map((issue) => issue.claim_id);
    }

    expect(await driftedIds("def foo():\n    # returns the threshold\n    return 3\n")).toEqual([]);
  });

  test("a real value change drifts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
    const file = join(repo, "mod.py");
    const anchor = { file: "mod.py", symbol: "foo" };
    const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

    writeFileSync(file, "def foo():\n    # returns the threshold\n    return 3\n");
    const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

    async function driftedIds(variant) {
      writeFileSync(file, variant);
      const result = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver(), baseline);
      return result.drifted.map((issue) => issue.claim_id);
    }

    expect(await driftedIds("def foo():\n    # returns the threshold\n    return 8\n")).toEqual(["claim.foo"]);
  });

  test("comment-only edits do not drift", async () => {
    const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
    const file = join(repo, "mod.py");
    const anchor = { file: "mod.py", symbol: "foo" };
    const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

    writeFileSync(file, "def foo():\n    # returns the threshold\n    return 3\n");
    const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

    async function driftedIds(variant) {
      writeFileSync(file, variant);
      const result = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver(), baseline);
      return result.drifted.map((issue) => issue.claim_id);
    }

    expect(await driftedIds("def foo():\n    # returns the configured threshold value\n    return 3\n")).toEqual([]);
  });

  test("whitespace-only edits do not drift", async () => {
    const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
    const file = join(repo, "mod.py");
    const anchor = { file: "mod.py", symbol: "foo" };
    const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

    writeFileSync(file, "def foo():\n    # returns the threshold\n    return 3\n");
    const baseline = new Map([["claim.foo", await fingerprintClaimAnchors(repo, [anchor], new CodeAnchorResolver())]]);

    async function driftedIds(variant) {
      writeFileSync(file, variant);
      const result = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver(), baseline);
      return result.drifted.map((issue) => issue.claim_id);
    }

    expect(await driftedIds("def foo():\n\n    # returns the threshold\n    return 3\n\n")).toEqual([]);
  });

  test("a claim with no stored baseline is treated as unknown, never drifted", async () => {
    const repo = mkdtempSync(join(tmpdir(), "greplica-anchor-drift-test-"));
    const anchor = { file: "mod.py", symbol: "foo" };
    const claim = { id: "claim.foo", kind: "fact", text: "foo returns 3", truth: "code_verified", intent: "intended", code_anchors: [anchor] };

    const noBaseline = await auditClaimCodeAnchors(repo, [claim], new CodeAnchorResolver());
    expect(noBaseline.drifted).toEqual([]);
  });
});
