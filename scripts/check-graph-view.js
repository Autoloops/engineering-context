import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));
const { normalizeProposal } = await import(new URL("dist/libs/knowledge-graph/proposal.js", root));

// Comment-only URLs baked into the vendored chart.js / chartjs-plugin-datalabels
// headers. These are text, not network requests, so they're safe to allow —
// anything outside this list found in the generated HTML fails the test.
const ALLOWED_URL_SUBSTRINGS = ["https://www.chartjs.org", "https://chartjs-plugin-datalabels.netlify.app", "https://github.com/kurkle/color"];

function assertSelfContained(html, label) {
  // Graph view must be a self-contained artifact: no CDN or other external
  // script/link tags, so it renders identically with no network access.
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, `${label}: no <script src> tags`);
  assert.doesNotMatch(html, /<link[^>]+\bhref=/i, `${label}: no <link href> tags`);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/i, `${label}: no jsdelivr reference`);
  assert.doesNotMatch(html, /\bunpkg\.com\b/i, `${label}: no unpkg reference`);
  assert.doesNotMatch(html, /\bcdnjs\.[a-z.]+\b/i, `${label}: no cdnjs reference`);

  // Broad guard: every http(s) URL literal anywhere in the document must be
  // one of the known-benign in-comment mentions inside the vendored bundles,
  // not a new external resource reference.
  const urls = html.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  for (const url of urls) {
    assert.ok(
      ALLOWED_URL_SUBSTRINGS.some((allowed) => url.startsWith(allowed)),
      `${label}: unexpected external URL found in generated HTML: ${url}`,
    );
  }

  // Vendor bundles must be inlined with real content, not stubbed/emptied out.
  assert.match(html, /Chart\.js v4\.4\.7/, `${label}: expected chart.js source to be inlined`);
  assert.match(html, /chartjs-plugin-datalabels v2\.2\.0/, `${label}: expected chartjs-plugin-datalabels source to be inlined`);
  const chartJsMarker = html.indexOf("Chart.js v4.4.7");
  const nextScriptClose = html.indexOf("</script>", chartJsMarker);
  assert.ok(nextScriptClose - chartJsMarker > 100_000, `${label}: inlined chart.js payload looks too small to be the real bundle`);

  // Every <script ...> must be balanced by a </script>: confirms the vendor
  // payloads (and the JSON graph-data payload) didn't smuggle in a literal
  // "</script" that would truncate an earlier tag and corrupt the page.
  const openTags = html.match(/<script[^>]*>/gi) ?? [];
  const closeTags = html.match(/<\/script>/gi) ?? [];
  assert.equal(openTags.length, closeTags.length, `${label}: script tags must be balanced`);
  assert.equal(openTags.length, 4, `${label}: expected exactly 4 script tags (graph-data, chart.js, datalabels, app logic)`);
}

async function checkNullAnchorComponent() {
  const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-view-test-"));
  const db = openDatabase(join(tmp, "graph.db"));
  try {
    const repository = new SqliteRepository(db);
    const service = new KnowledgeGraphService(repository);
    const repo = {
      repo_root: join(tmp, "repo"),
      repo_name: "graph-view-null-anchor",
      default_branch: "main",
    };

    const initialized = service.initRepo(repo);
    const memoryCommit = repository.createMemoryCommit({
      scope_id: initialized.working_scope_id,
      title: "Seed null component anchor",
    });

    repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, {
      title: "Seed null component anchor",
      creates: {
        components: [
          {
            id: "component.no_anchor",
            name: "Component Without Anchor",
          },
        ],
      },
    });

    const html = service.buildGraphView(repo);
    assert.match(html, /Component Without Anchor/);
    assert.match(html, /Greplica graph view/);
    assertSelfContained(html, "null-anchor scenario");
  } finally {
    db.close();
  }
}

async function checkRichGraphIsSelfContained() {
  const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-view-rich-test-"));
  const db = openDatabase(join(tmp, "graph.db"));
  try {
    const repository = new SqliteRepository(db);
    const service = new KnowledgeGraphService(repository);
    const repo = {
      repo_root: join(tmp, "repo"),
      repo_name: "graph-view-rich",
      default_branch: "main",
    };

    const initialized = service.initRepo(repo);

    const firstCommit = repository.createMemoryCommit({
      scope_id: initialized.working_scope_id,
      title: "Seed rich graph — batch 1",
    });
    repository.createProposalRecords(
      initialized.working_scope_id,
      firstCommit.id,
      normalizeProposal({
        title: "Seed rich graph — batch 1",
        creates: {
          sources: [{ id: "source.pairing", kind: "session", ref: "session-abc", title: "Pairing session with Jane" }],
          components: [
            { id: "component.auth", name: "Auth Service", code_anchor: "libs/auth/service.ts:1-40", contains: "component.auth.token" },
            { id: "component.auth.token", name: "Token Store", code_anchor: "libs/auth/token-store.ts:1-20" },
          ],
          flows: [{ id: "flow.login", name: "Login Flow", touches: "component.auth" }],
          claims: [
            {
              id: "claim.code_fact",
              kind: "fact",
              text: "Tokens are hashed before storage",
              truth: "code_verified",
              intent: "intended",
              code_anchors: ["libs/auth/token-store.ts:12"],
              about: "component.auth",
            },
            {
              id: "claim.session_decision",
              kind: "decision",
              text: "We decided to rotate tokens every 24 hours",
              truth: "unknown",
              intent: "intended",
              evidenced_by: "source.pairing",
              about: "component.auth",
            },
            {
              id: "claim.requirement",
              kind: "requirement",
              text: "Login must reject expired tokens",
              truth: "unknown",
              intent: "intended",
              about: "flow.login",
            },
            {
              id: "claim.risk",
              kind: "risk",
              text: "Token store has no rate limiting",
              truth: "unknown",
              intent: "intended",
              about: "component.auth",
            },
            {
              id: "claim.question",
              kind: "question",
              text: "Should refresh tokens be revocable?",
              truth: "unknown",
              intent: "intended",
              about: "component.auth",
            },
            {
              id: "claim.old_task",
              kind: "task",
              text: "Add basic token rotation",
              truth: "unknown",
              intent: "intended",
              about: "component.auth",
            },
          ],
        },
      }),
    );

    const secondCommit = repository.createMemoryCommit({
      scope_id: initialized.working_scope_id,
      title: "Seed rich graph — batch 2 (supersedes)",
    });
    repository.createProposalRecords(
      initialized.working_scope_id,
      secondCommit.id,
      normalizeProposal({
        title: "Seed rich graph — batch 2 (supersedes)",
        creates: {
          claims: [
            {
              id: "claim.new_task",
              kind: "task",
              text: "Add token rotation with configurable interval",
              truth: "unknown",
              intent: "intended",
              about: "component.auth",
              supersedes: "claim.old_task",
            },
          ],
        },
      }),
    );

    const html = service.buildGraphView(repo);

    // Sanity: the richer, multi-kind, multi-source, superseding dataset still
    // renders the expected content...
    assert.match(html, /Auth Service/);
    // Token Store is nested under Auth Service via "contains", so it's rolled
    // up into the parent's subcomponent count rather than shown as its own
    // top-level row — this exercises the contains-edge path in buildGraphViewData.
    const authRowMatch = html.match(/<tr data-id="component\.auth">[\s\S]*?<\/tr>/);
    assert.ok(authRowMatch, "expected a table row for component.auth");
    assert.match(authRowMatch[0], /<td class="count">1<\/td><\/tr>$/, "expected Auth Service to report 1 subcomponent");
    assert.match(html, /Login Flow/);
    assert.match(html, /Tokens are hashed before storage/);
    assert.match(html, /We decided to rotate tokens every 24 hours/);
    assert.match(html, /Pairing session with Jane/);
    assert.match(html, /Add token rotation with configurable interval/);
    assert.match(html, /data-freshness="superseded"/, "expected the superseded claim to be marked as such");
    assert.match(html, /"total":6/, "expected claims timeline summary to count 6 active claims");

    // ...and, regardless of how much data or how many kinds/sources/superseded
    // claims it contains, it remains fully self-contained (this is the actual
    // regression check for #118: no data shape should introduce a network
    // dependency into the generated HTML).
    assertSelfContained(html, "rich scenario");
  } finally {
    db.close();
  }
}

await checkNullAnchorComponent();
await checkRichGraphIsSelfContained();

console.log("Graph view checks passed.");
