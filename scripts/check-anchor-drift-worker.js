import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { buildAnchorDriftProposal, inspectAnchorDriftCheckout, runAnchorDriftPass } = await import(
  new URL("dist/libs/hooks/anchor-drift.js", root)
);
const { LocalGraphMemoryProvider } = await import(new URL("dist/libs/knowledge-graph/local-provider.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { RepoInstallationStore } = await import(new URL("dist/libs/install/repo-installation-store.js", root));
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

checkProposalBuilder();
checkCheckoutEligibility();
await checkLocalReconciliation();

console.log("check-anchor-drift-worker: ok");

function checkProposalBuilder() {
  const graph = {
    components: [{ id: "component.checkout", name: "Checkout" }],
    flows: [],
    sources: [{ id: "source.session", kind: "session", ref: "codex:test" }],
    claims: [
      codeClaim("claim.content", "Checkout applies a 5% discount", [
        { file: "checkout.ts", symbol: "discount" },
        { file: "checkout-config.ts" },
      ]),
      codeClaim("claim.missing", "Legacy checkout helper exists", [{ file: "legacy.ts", symbol: "legacy" }]),
      { id: "claim.source", kind: "fact", text: "Source fact", truth: "source_verified", intent: "intended" },
      { id: "claim.unknown", kind: "fact", text: "Unknown fact", truth: "unknown", intent: "unknown" },
      codeClaim("claim.fresh", "Fresh fact", [{ file: "fresh.ts", symbol: "fresh" }]),
    ],
    edges: [
      canonicalEdge("about", "claim", "claim.content", "component", "component.checkout"),
      canonicalEdge("evidenced_by", "claim", "claim.content", "source", "source.session"),
      canonicalEdge("about", "claim", "claim.missing", "component", "component.checkout"),
    ],
  };
  const audit = emptyAudit();
  audit.drifted.push(
    { claim_id: "claim.content", anchor: { file: "checkout.ts", symbol: "discount" }, status: "drifted" },
    { claim_id: "claim.content", anchor: { file: "checkout.ts", symbol: "discount" }, status: "drifted" },
    { claim_id: "claim.source", anchor: { file: "source.ts", symbol: "source" }, status: "drifted" },
    { claim_id: "claim.unknown", anchor: { file: "unknown.ts", symbol: "unknown" }, status: "drifted" },
    { claim_id: "claim.content", status: "drifted" },
  );
  audit.missing_files.push({
    claim_id: "claim.content",
    anchor: { file: "checkout-config.ts" },
    status: "missing_file",
  });
  audit.missing_symbols.push({
    claim_id: "claim.missing",
    anchor: { file: "legacy.ts", symbol: "legacy" },
    status: "missing_symbol",
  });
  audit.missing_anchors.push({ claim_id: "claim.fresh", status: "missing_anchors" });
  audit.ambiguous_symbols.push({
    claim_id: "claim.fresh",
    anchor: { file: "fresh.ts", symbol: "fresh" },
    status: "ambiguous_symbol",
  });
  audit.unsupported_languages.push({
    claim_id: "claim.fresh",
    anchor: { file: "fresh.xyz", symbol: "fresh" },
    status: "unsupported_language",
  });

  const proposal = buildAnchorDriftProposal(graph, audit, "abc123");
  assert.ok(proposal);
  assert.deepEqual(proposal, buildAnchorDriftProposal(graph, audit, "abc123"), "proposal output must be deterministic");
  assert.equal(proposal.creates.claims.length, 2, "only active code-verified claims should be demoted");

  const contentReplacement = proposal.creates.claims.find((claim) => claim.text.includes("5%"));
  assert.ok(contentReplacement);
  assert.equal(contentReplacement.truth, "unknown");
  assert.equal(contentReplacement.kind, "fact");
  assert.equal(contentReplacement.intent, "intended");
  assert.deepEqual(contentReplacement.about, ["component.checkout"]);
  assert.equal(contentReplacement.code_anchors, undefined);
  assert.equal(contentReplacement.evidenced_by, undefined);

  const contentEdge = proposal.creates.edges.find((edge) => edge.to === "claim.content");
  assert.ok(contentEdge);
  assert.equal(contentEdge.metadata.reason, "anchor_drift");
  assert.equal(contentEdge.metadata.git_commit_sha, "abc123");
  assert.deepEqual(
    contentEdge.metadata.issues.map((issue) => issue.status),
    ["drifted", "missing_file"],
    "duplicate issues should collapse and sort deterministically",
  );
  assert.equal(proposal.creates.claims.some((claim) => claim.text === "Source fact"), false);
  assert.equal(proposal.creates.claims.some((claim) => claim.text === "Unknown fact"), false);
  assert.equal(proposal.creates.claims.some((claim) => claim.text === "Fresh fact"), false);
}

function checkCheckoutEligibility() {
  const repo = createGitRepo("greplica-anchor-worker-checkout-");
  try {
    const tracked = join(repo, "tracked.txt");
    writeFileSync(tracked, "baseline\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "baseline");

    assert.equal(inspectAnchorDriftCheckout(repo, "main").eligible, true);
    writeFileSync(join(repo, "untracked.txt"), "local only\n");
    assert.equal(inspectAnchorDriftCheckout(repo, "main").eligible, true, "untracked files should not block drift checks");

    writeFileSync(tracked, "unstaged\n");
    assert.deepEqual(inspectAnchorDriftCheckout(repo, "main"), { eligible: false, reason: "dirty_tracked_files" });
    git(repo, "restore", "tracked.txt");

    writeFileSync(tracked, "staged\n");
    git(repo, "add", "tracked.txt");
    assert.deepEqual(inspectAnchorDriftCheckout(repo, "main"), { eligible: false, reason: "dirty_tracked_files" });
    git(repo, "restore", "--staged", "tracked.txt");
    git(repo, "restore", "tracked.txt");

    git(repo, "switch", "-c", "feature");
    assert.deepEqual(inspectAnchorDriftCheckout(repo, "main"), { eligible: false, reason: "not_default_branch" });
    git(repo, "switch", "main");
    git(repo, "checkout", "--detach", "HEAD");
    assert.deepEqual(inspectAnchorDriftCheckout(repo, "main"), { eligible: false, reason: "detached_head" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function checkLocalReconciliation() {
  const repo = createGitRepo("greplica-anchor-worker-integration-");
  const greplicaHome = mkdtempSync(join(tmpdir(), "greplica-anchor-worker-home-"));
  const dbPath = join(greplicaHome, "graph.db");
  const previousGreplicaHome = process.env.GREPLICA_HOME;
  process.env.GREPLICA_HOME = greplicaHome;
  const db = openDatabase(dbPath);
  try {
    const files = {
      content: join(repo, "content.py"),
      missingFile: join(repo, "removed.py"),
      missingSymbol: join(repo, "symbol.py"),
      fresh: join(repo, "fresh.py"),
    };
    writeFileSync(files.content, "def content_value():\n    return 3\n\ndef content_helper():\n    return 30\n");
    writeFileSync(files.missingFile, "def removed_value():\n    return 4\n");
    writeFileSync(files.missingSymbol, "def old_symbol():\n    return 5\n");
    writeFileSync(files.fresh, "def fresh_value():\n    return 6\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "seed code");

    const repoRef = { repo_root: repo, repo_name: "anchor-worker-fixture", default_branch: "main" };
    const repository = new SqliteRepository(db);
    const service = createTestService(repository);
    const initialized = service.initRepo(repoRef);
    const installation = new RepoInstallationStore(db).activateLocal(repoRef, {
      hooksEnabled: true,
      autoMemoryUpdates: true,
    });
    await service.applyProposal(repoRef, {
      title: "Seed verified anchor claims",
      creates: {
        components: [{ id: "component.fixture", name: "Fixture" }],
        claims: [
          {
            ...codeClaim("claim.content", "content_value returns 3", [
              { file: "content.py", symbol: "content_value" },
              { file: "content.py", symbol: "content_helper" },
            ]),
            about: "component.fixture",
          },
          { ...codeClaim("claim.missing_file", "removed_value returns 4", [{ file: "removed.py", symbol: "removed_value" }]), about: "component.fixture" },
          { ...codeClaim("claim.missing_symbol", "old_symbol returns 5", [{ file: "symbol.py", symbol: "old_symbol" }]), about: "component.fixture" },
          { ...codeClaim("claim.fresh", "fresh_value returns 6", [{ file: "fresh.py", symbol: "fresh_value" }]), about: "component.fixture" },
        ],
      },
    });

    writeFileSync(files.content, "def content_value():\n    return 8\n\ndef content_helper():\n    return 30\n");
    unlinkSync(files.missingFile);
    writeFileSync(files.missingSymbol, "def new_symbol():\n    return 5\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "drift anchored code");
    const gitHead = git(repo, "rev-parse", "HEAD");

    const passDb = openDatabase(dbPath);
    const provider = new LocalGraphMemoryProvider(
      installation,
      repoRef,
      createTestService(new SqliteRepository(passDb)),
      passDb,
    );
    let firstPass;
    try {
      const audit = await provider.auditCodeAnchors();
      assert.deepEqual(
        audit.drifted.map((issue) => `${issue.claim_id}:${issue.anchor?.symbol ?? ""}`),
        ["claim.content:content_value"],
        "one changed anchor should make its multi-anchor claim actionable",
      );
      assert.deepEqual(audit.missing_files.map((issue) => issue.claim_id), ["claim.missing_file"]);
      assert.deepEqual(audit.missing_symbols.map((issue) => issue.claim_id), ["claim.missing_symbol"]);
      firstPass = await runAnchorDriftPass(provider, gitHead);
    } finally {
      provider.close();
    }

    assert.equal(firstPass.status, "applied");
    assert.deepEqual(firstPass.claimIds, ["claim.content", "claim.missing_file", "claim.missing_symbol"]);
    const active = service.readGraph(repoRef);
    assert.deepEqual(
      active.claims.filter((claim) => claim.truth === "code_verified").map((claim) => claim.id),
      ["claim.fresh"],
      "only the unchanged claim should remain code-verified",
    );
    const replacements = active.claims.filter((claim) => claim.truth === "unknown");
    assert.equal(replacements.length, 3);
    assert.equal(replacements.every((claim) => claim.code_anchors === undefined), true);
    assert.equal(
      active.edges.filter((edge) => edge.kind === "about" && replacements.some((claim) => claim.id === edge.from_id)).length,
      3,
      "replacement claims should remain connected to their component",
    );
    const supersedes = db
      .prepare("SELECT metadata FROM edges WHERE repo_id = ? AND kind = 'supersedes' ORDER BY id")
      .all(initialized.repo_id)
      .map((row) => ({ metadata: JSON.parse(row.metadata) }));
    assert.equal(supersedes.length, 3);
    assert.equal(supersedes.every((edge) => edge.metadata?.git_commit_sha === gitHead), true);
    assert.deepEqual(
      supersedes.flatMap((edge) => edge.metadata?.issues?.map((issue) => issue.status) ?? []).sort(),
      ["drifted", "missing_file", "missing_symbol"],
      "supersession metadata should preserve the deterministic audit evidence",
    );
    assert.deepEqual(
      repository.readSupersededClaims(initialized.repo_id).map((claim) => claim.id).sort(),
      ["claim.content", "claim.missing_file", "claim.missing_symbol"],
      "original claims should remain in superseded history",
    );

    const retryDb = openDatabase(dbPath);
    const retryProvider = new LocalGraphMemoryProvider(
      installation,
      repoRef,
      createTestService(new SqliteRepository(retryDb)),
      retryDb,
    );
    try {
      assert.deepEqual(await runAnchorDriftPass(retryProvider, gitHead), { status: "clean" });
    } finally {
      retryProvider.close();
    }
    assert.equal(service.readGraph(repoRef).claims.length, 4, "a retry should not create duplicate replacements");
  } finally {
    db.close();
    if (previousGreplicaHome === undefined) delete process.env.GREPLICA_HOME;
    else process.env.GREPLICA_HOME = previousGreplicaHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(greplicaHome, { recursive: true, force: true });
  }
}

function codeClaim(id, text, codeAnchors) {
  return { id, kind: "fact", text, truth: "code_verified", intent: "intended", code_anchors: codeAnchors };
}

function canonicalEdge(kind, fromType, fromId, toType, toId) {
  return {
    id: `edge_${kind}_${fromId}_${toId}`,
    kind,
    from_type: fromType,
    from_id: fromId,
    to_type: toType,
    to_id: toId,
  };
}

function emptyAudit() {
  return {
    missing_anchors: [],
    missing_files: [],
    missing_symbols: [],
    ambiguous_symbols: [],
    unsupported_languages: [],
    drifted: [],
  };
}

function createTestService(repository) {
  return new KnowledgeGraphService(repository, undefined, {
    ensureForGraph: async () => ({
      created: 0,
      reused: 0,
      provider: "local",
      model: "test",
      dimensions: 0,
    }),
  });
}

function createGitRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "greplica-test@example.com");
  git(repo, "config", "user.name", "Greplica Test");
  return repo;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
