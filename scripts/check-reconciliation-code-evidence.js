import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const {
  buildReconciliationCodeEvidence,
  hasValidReconciliationCodeEvidenceHash,
  isReconciliationCodeEvidenceEntryActionable,
  reconciliationCodeEvidenceHash,
  reconciliationCodeEvidenceLimits,
} = await import("../dist/libs/knowledge-graph/code-anchors/evidence.js");

const temporary = mkdtempSync(join(tmpdir(), "greplica-code-evidence-"));
const repoRoot = join(temporary, "repo");
const submoduleSource = join(temporary, "submodule-source");
const outsideSecretPath = join(temporary, "outside-secret.txt");
mkdirSync(repoRoot);
mkdirSync(submoduleSource);
writeFileSync(outsideSecretPath, "OUTSIDE_SECRET_MUST_NEVER_BE_READ\n");
exec("git", ["init", "--quiet", submoduleSource]);
exec("git", ["-C", submoduleSource, "config", "user.email", "test@example.com"]);
exec("git", ["-C", submoduleSource, "config", "user.name", "Test"]);
writeFileSync(join(submoduleSource, "submodule-secret.ts"), "SUBMODULE_SECRET_MUST_NEVER_BE_READ\n");
exec("git", ["-C", submoduleSource, "add", "."]);
exec("git", ["-C", submoduleSource, "commit", "--quiet", "-m", "submodule fixture"]);
exec("git", ["init", "--quiet", repoRoot]);
exec("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
exec("git", ["-C", repoRoot, "config", "user.name", "Test"]);

mkdirSync(join(repoRoot, "src"));
const exactPath = join(repoRoot, "src", "exact.ts");
writeFileSync(join(repoRoot, ".gitignore"), "ignored-secret.txt\noutside-link.txt\n");
writeFileSync(join(repoRoot, "ignored-secret.txt"), "IGNORED_SECRET_MUST_NEVER_BE_READ\n");
symlinkSync("ignored-secret.txt", join(repoRoot, "ignored-link.txt"));
writeFileSync(exactPath, [
  "export function exactValue() {",
  "  return 1;",
  "}",
  "",
].join("\n"));
writeFileSync(
  join(repoRoot, "large.txt"),
  Array.from({ length: 300 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}-${"x".repeat(80)}`).join("\n") + "\n",
);
writeFileSync(join(repoRoot, ".env"), "RECONCILIATION_TEST_SECRET=must-not-appear\n");
const providerToken = `ghp_${"A".repeat(36)}`;
writeFileSync(join(repoRoot, "leaky.ts"), `export const credential = "${providerToken}";\n`);
writeFileSync(join(repoRoot, "private-material.txt"), [
  "-----BEGIN PRIVATE KEY-----",
  "PEM_SECRET_MUST_NEVER_BE_READ",
  "-----END PRIVATE KEY-----",
  "",
].join("\n"));
writeFileSync(join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
writeFileSync(
  join(repoRoot, "huge.txt"),
  Buffer.alloc(reconciliationCodeEvidenceLimits.maxReadableFileBytes + 1, "h"),
);
symlinkSync(outsideSecretPath, join(repoRoot, "outside-link.txt"));
exec("git", [
  "-c",
  "protocol.file.allow=always",
  "-C",
  repoRoot,
  "submodule",
  "add",
  "--quiet",
  submoduleSource,
  "embedded",
]);
exec("git", ["-C", repoRoot, "add", "."]);
exec("git", ["-C", repoRoot, "commit", "--quiet", "-m", "evidence fixture"]);
const oldSha = git(repoRoot, ["rev-parse", "HEAD"]);

writeFileSync(exactPath, [
  "export function exactValue() {",
  "  return 2;",
  "}",
  "",
].join("\n"));
exec("git", ["-C", repoRoot, "add", "src/exact.ts"]);
exec("git", ["-C", repoRoot, "commit", "--quiet", "-m", "change exact code"]);
const exactSha = git(repoRoot, ["rev-parse", "HEAD"]);

const envelope = {
  managedRepoId: "11111111-1111-4111-8111-111111111111",
  repository: "example/project",
};
const hashVectorSnippet = "const x = 1;\n";
const hashVectorPayload = {
  managed_repo_id: envelope.managedRepoId,
  repository: envelope.repository,
  attested_git_sha: "a".repeat(40),
  truncated: false,
  entries: [{
    version_id: "v1",
    object_type: "claim",
    anchor: { file: "src/a.ts", symbol: "run" },
    status: "resolved",
    normalized_path: "src/a.ts",
    anchor_start_line: 2,
    anchor_end_line: 3,
    snippet_start_line: 1,
    snippet_end_line: 4,
    snippet: hashVectorSnippet,
    snippet_sha256: "95befdd6e691d4d89031a2a2901cc74fc6242109980b060e08ddf87829924483",
    anchor_fingerprint: "0123456789abcdef",
  }],
};
assert.equal(
  reconciliationCodeEvidenceHash(hashVectorPayload),
  "d78af6307c46ac5f0f974d16c0d97b6ee992464b7f28c976591c8681432b66cc",
  "canonical evidence hashing must remain interoperable with managed validation",
);
const exactAnchor = {
  versionId: "version-exact",
  objectType: "claim",
  anchor: { file: "src/exact.ts", symbol: "exactValue" },
};

exec("git", ["-C", repoRoot, "checkout", "--quiet", "--detach", oldSha]);
const oldEvidence = await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: oldSha,
  anchors: [exactAnchor],
});
assert.match(oldEvidence.entries[0].snippet, /return 1/);
exec("git", ["-C", repoRoot, "checkout", "--quiet", "--detach", exactSha]);
const exactEvidence = await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: exactSha,
  anchors: [exactAnchor],
});
assert.equal(exactEvidence.attested_git_sha, exactSha);
assert.equal(exactEvidence.entries[0].status, "resolved");
assert.match(exactEvidence.entries[0].snippet, /return 2/);
assert.equal(
  exactEvidence.entries[0].snippet_sha256,
  sha256(exactEvidence.entries[0].snippet),
  "snippet hash must cover the exact transmitted UTF-8 bytes",
);
assert.notEqual(exactEvidence.entries[0].snippet_sha256, oldEvidence.entries[0].snippet_sha256);
assert.notEqual(exactEvidence.entries[0].anchor_fingerprint, oldEvidence.entries[0].anchor_fingerprint);
assert.notEqual(exactEvidence.evidence_sha256, oldEvidence.evidence_sha256);

const { evidence_sha256: evidenceHash, ...evidencePayload } = exactEvidence;
assert.equal(evidenceHash, reconciliationCodeEvidenceHash(evidencePayload));
assert.equal(hasValidReconciliationCodeEvidenceHash(exactEvidence), true);
assert.equal(isReconciliationCodeEvidenceEntryActionable(exactEvidence.entries[0]), true);
const tamperedPayload = structuredClone(evidencePayload);
tamperedPayload.entries[0].snippet = tamperedPayload.entries[0].snippet.replace("return 2", "return 3");
assert.notEqual(evidenceHash, reconciliationCodeEvidenceHash(tamperedPayload));
const tamperedPacket = {
  ...tamperedPayload,
  evidence_sha256: evidenceHash,
};
assert.equal(hasValidReconciliationCodeEvidenceHash(tamperedPacket), false);
assert.equal(isReconciliationCodeEvidenceEntryActionable(tamperedPacket.entries[0]), false);

const deterministic = await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: exactSha,
  anchors: [exactAnchor, exactAnchor, structuredClone(exactAnchor)],
});
assert.equal(deterministic.entries.length, 1, "identical version anchors must be deduplicated");
assert.deepEqual(deterministic, exactEvidence, "packet ordering and hashing must be deterministic");

const bounded = await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: exactSha,
  anchors: [{
    versionId: "version-large",
    objectType: "component",
    anchor: { file: "large.txt" },
  }],
});
const boundedEntry = bounded.entries[0];
assert.equal(boundedEntry.status, "file_only");
assert.equal(boundedEntry.truncated, true);
assert.ok(Buffer.byteLength(boundedEntry.snippet, "utf8") <= reconciliationCodeEvidenceLimits.maxSnippetBytes);
assert.ok(
  boundedEntry.snippet_end_line - boundedEntry.snippet_start_line + 1 <=
    reconciliationCodeEvidenceLimits.maxSnippetLines,
);

const aggregate = await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: exactSha,
  anchors: Array.from({ length: 20 }, (_, index) => ({
    versionId: `version-large-${String(index).padStart(2, "0")}`,
    objectType: "claim",
    anchor: { file: "large.txt" },
  })),
});
const aggregateBytes = aggregate.entries.reduce(
  (total, entry) => total + Buffer.byteLength(entry.snippet ?? "", "utf8"),
  0,
);
assert.ok(aggregateBytes <= reconciliationCodeEvidenceLimits.maxTotalSnippetBytes);
assert.equal(aggregate.truncated, true);
assert.ok(
  aggregate.entries.some((entry) => entry.omission_reason === "total_budget"),
  "aggregate budget exhaustion must be explicit",
);

const omissions = await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: exactSha,
  anchors: [{
    versionId: "version-env",
    objectType: "claim",
    anchor: { file: ".env" },
  }, {
    versionId: "version-binary",
    objectType: "claim",
    anchor: { file: "binary.bin" },
  }, {
    versionId: "version-huge",
    objectType: "claim",
    anchor: { file: "huge.txt" },
  }, {
    versionId: "version-missing",
    objectType: "claim",
    anchor: { file: "missing.ts" },
  }, {
    versionId: "version-sensitive-content",
    objectType: "claim",
    anchor: { file: "leaky.ts" },
  }, {
    versionId: "version-submodule",
    objectType: "claim",
    anchor: { file: "embedded/submodule-secret.ts" },
  }, {
    versionId: "version-private-key",
    objectType: "claim",
    anchor: { file: "private-material.txt" },
  }, {
    versionId: "version-ignored",
    objectType: "claim",
    anchor: { file: "ignored-secret.txt" },
  }, {
    versionId: "version-ignored-link",
    objectType: "claim",
    anchor: { file: "ignored-link.txt" },
  }],
});
assert.equal(omissions.entries.find((entry) => entry.version_id === "version-env").omission_reason, "sensitive_path");
assert.equal(omissions.entries.find((entry) => entry.version_id === "version-binary").omission_reason, "binary");
assert.equal(omissions.entries.find((entry) => entry.version_id === "version-huge").omission_reason, "file_too_large");
assert.equal(omissions.entries.find((entry) => entry.version_id === "version-missing").status, "missing_file");
assert.equal(
  omissions.entries.find((entry) => entry.version_id === "version-sensitive-content").omission_reason,
  "sensitive_content",
);
assert.equal(
  omissions.entries.find((entry) => entry.version_id === "version-submodule").omission_reason,
  "submodule",
);
assert.equal(
  omissions.entries.find((entry) => entry.version_id === "version-private-key").omission_reason,
  "sensitive_content",
);
assert.equal(
  omissions.entries.find((entry) => entry.version_id === "version-ignored").omission_reason,
  "not_in_attested_tree",
);
assert.equal(
  omissions.entries.find((entry) => entry.version_id === "version-ignored-link").omission_reason,
  "symlink",
);
assert.doesNotMatch(JSON.stringify(omissions), /must-not-appear/);
assert.doesNotMatch(JSON.stringify(omissions), new RegExp(providerToken));
assert.doesNotMatch(JSON.stringify(omissions), /SUBMODULE_SECRET_MUST_NEVER_BE_READ/);
assert.doesNotMatch(JSON.stringify(omissions), /PEM_SECRET_MUST_NEVER_BE_READ|BEGIN PRIVATE KEY/);
assert.doesNotMatch(JSON.stringify(omissions), /IGNORED_SECRET_MUST_NEVER_BE_READ/);
assert.ok(omissions.entries.every((entry) =>
  entry.omission_reason === "missing_file" || entry.snippet === undefined
));
assert.ok(omissions.entries.every((entry) => !isReconciliationCodeEvidenceEntryActionable(entry)));

await assert.rejects(
  buildReconciliationCodeEvidence(repoRoot, {
    ...envelope,
    attestedGitSha: exactSha,
    anchors: [{
      versionId: "version-outside",
      objectType: "claim",
      anchor: { file: "outside-link.txt" },
    }],
  }),
  /escapes the repository/,
);
for (const unsafePath of [
  "../outside-secret.txt",
  "./exact.ts",
  "nested/../exact.ts",
  "/tmp/exact.ts",
  "a".repeat(reconciliationCodeEvidenceLimits.maxPathBytes + 1),
]) {
  await assert.rejects(
    buildReconciliationCodeEvidence(repoRoot, {
      ...envelope,
      attestedGitSha: exactSha,
      anchors: [{
        versionId: "version-unsafe",
        objectType: "claim",
        anchor: { file: unsafePath },
      }],
    }),
    /anchor path/,
  );
}

await assert.rejects(
  buildReconciliationCodeEvidence(repoRoot, {
    ...envelope,
    attestedGitSha: exactSha,
    anchors: Array.from({ length: reconciliationCodeEvidenceLimits.maxEntries + 1 }, (_, index) => ({
      versionId: `version-${String(index).padStart(3, "0")}`,
      objectType: "claim",
      anchor: { file: "src/exact.ts" },
    })),
  }),
  /exceeds 128 unique anchors/,
);
await assert.rejects(
  buildReconciliationCodeEvidence(repoRoot, {
    ...envelope,
    attestedGitSha: oldSha,
    anchors: [exactAnchor],
  }),
  /does not equal attested SHA/,
);

const cleanSnapshot = workingTreeSnapshot(repoRoot);
const beforeStatus = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
await buildReconciliationCodeEvidence(repoRoot, {
  ...envelope,
  attestedGitSha: exactSha,
  anchors: [exactAnchor],
});
assert.equal(git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]), beforeStatus);
assert.deepEqual(workingTreeSnapshot(repoRoot), cleanSnapshot, "evidence collection must not write repository files");

writeFileSync(exactPath, readFileSync(exactPath, "utf8").replace("return 2", "return 9"));
await assert.rejects(
  buildReconciliationCodeEvidence(repoRoot, {
    ...envelope,
    attestedGitSha: exactSha,
    anchors: [exactAnchor],
  }),
  /clean exact-SHA checkout/,
);

console.log("reconciliation code evidence checks passed");

function exec(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

function git(root, args) {
  return exec("git", ["-C", root, ...args]).trim();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function workingTreeSnapshot(root) {
  const snapshot = [];
  visit(root);
  return snapshot;

  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && name === ".git") continue;
      const path = join(directory, name);
      const relativePath = relative(root, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        snapshot.push([relativePath, "symlink", readlinkSync(path)]);
      } else if (stats.isDirectory()) {
        snapshot.push([relativePath, "directory"]);
        visit(path);
      } else {
        snapshot.push([relativePath, "file", createHash("sha256").update(readFileSync(path)).digest("hex")]);
      }
    }
  }
}
