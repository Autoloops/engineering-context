// End-to-end regression check for github.com/Autoloops/greplica/issues/118:
// generated graph view HTML must render its charts using only inlined
// assets, with zero network access. This actually launches a real browser
// against a file:// URL (no server, no CDN reachability) and inspects the
// live page state, which is the only way to prove the *symptom* described
// in the issue (charts silently failing to render) is gone — the static
// string checks in check-graph-view.js prove the HTML has no external
// references, but not that the inlined code actually executes correctly.
//
// Runs as part of `npm test`, but depends on a system Chrome/Chromium/Edge
// install, which isn't guaranteed on every dev machine or CI runner — so it
// skips (exit 0, with a log line) rather than failing when no browser binary
// is found. It can also be run on its own with:
// node scripts/check-graph-view-offline-browser.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

function findBrowserBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "microsoft-edge"]) {
    try {
      const resolved = execFileSync("which", [name], { encoding: "utf8" }).trim();
      if (resolved) return resolved;
    } catch {
      // not found on PATH, try the next candidate
    }
  }
  return null;
}

const browser = findBrowserBinary();
if (!browser) {
  console.log("Skipping browser regression check: no Chrome/Chromium/Edge binary found.");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "greplica-graph-view-browser-test-"));
const db = openDatabase(join(tmp, "graph.db"));

try {
  const repository = new SqliteRepository(db);
  const service = new KnowledgeGraphService(repository);
  const repo = { repo_root: join(tmp, "repo"), repo_name: "graph-view-browser-check", default_branch: "main" };
  const initialized = service.initRepo(repo);

  const memoryCommit = repository.createMemoryCommit({ scope_id: initialized.working_scope_id, title: "Seed browser check" });
  repository.createProposalRecords(initialized.working_scope_id, memoryCommit.id, {
    title: "Seed browser check",
    creates: {
      components: [{ id: "component.demo", name: "Demo Component" }],
      claims: [
        { id: "claim.fact", kind: "fact", text: "Demo fact claim", truth: "unknown", intent: "intended" },
        { id: "claim.decision", kind: "decision", text: "Demo decision claim", truth: "unknown", intent: "intended" },
      ],
    },
  });

  const html = service.buildGraphView(repo);

  // Test harness appended after the app's own script: by the time it runs,
  // viewFromHash() has already executed synchronously (there's no async gap
  // before charts are constructed), so window.Chart / Chart.instances are
  // populated the instant this code runs — no setTimeout race needed.
  const harness = `
  <script>
    (function () {
      var result = {
        chartDefined: typeof window.Chart !== "undefined",
        dataLabelsDefined: typeof window.ChartDataLabels !== "undefined",
        chartInstanceCount: typeof window.Chart !== "undefined" && window.Chart.instances ? Object.keys(window.Chart.instances).length : 0,
      };
      var marker = document.createElement("div");
      marker.id = "browser-test-result";
      marker.setAttribute("data-result", JSON.stringify(result));
      document.body.appendChild(marker);
    })();
  </script>`;
  const instrumentedHtml = html.replace("</body>", `${harness}\n</body>`);

  const htmlPath = join(tmp, "graph.html");
  writeFileSync(htmlPath, instrumentedHtml);

  // "#claims-overview" makes the page's own hashchange handler call
  // renderOverview() synchronously on load, so the pie charts are built
  // without needing to simulate a nav click.
  const fileUrl = `file://${htmlPath}#claims-overview`;

  const dom = execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--run-all-compositor-stages-before-draw",
      // Route every hostname to an unroutable address so any remaining CDN
      // reference fails closed, the same way it would on an offline machine
      // or behind a corporate firewall. file:// loads are unaffected since
      // they don't go through DNS/host resolution at all.
      "--host-resolver-rules=MAP * 0.0.0.0",
      "--virtual-time-budget=4000",
      "--dump-dom",
      fileUrl,
    ],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] },
  );

  const match = dom.match(/id="browser-test-result" data-result="([^"]+)"/);
  assert.ok(match, "expected the browser test harness marker to be present in the rendered DOM");

  const resultJson = match[1].replace(/&quot;/g, '"');
  const result = JSON.parse(resultJson);

  assert.equal(result.chartDefined, true, "window.Chart must be defined after loading the page with no network access");
  assert.equal(result.dataLabelsDefined, true, "window.ChartDataLabels must be defined after loading the page with no network access");
  assert.equal(result.chartInstanceCount, 3, "expected all 3 overview pie charts (type/source/freshness) to have rendered");
} finally {
  db.close();
}

console.log("Graph view offline browser check passed: charts rendered with zero network access.");
