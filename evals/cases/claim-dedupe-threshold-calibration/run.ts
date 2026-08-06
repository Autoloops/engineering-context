import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  findRepoRoot,
  readJson,
  round,
  timestamp,
  writeJson,
} from "../../lib/common.js";
import { createEmbedder } from "../../../libs/knowledge-graph/graph-context/embedder.js";
import { buildClaimDocuments } from "../../../libs/knowledge-graph/graph-context/documents.js";
import { cosineSimilarity } from "../../../libs/knowledge-graph/graph-context/vector.js";
import { graphContextConfig } from "../../../libs/knowledge-graph/graph-context/config.js";

const caseId = "claim-dedupe-threshold-calibration";

interface ClaimRecord {
  id: string;
  text: string;
}

interface RubricPair {
  candidate: string;
  existing: string;
  expected: "exact" | "paraphrase" | "distinct" | "unrelated";
  reason: string;
}

interface Rubric {
  case_id: string;
  benchmark_version: string;
  evaluation: {
    thresholds: number[];
  };
  score: {
    primary_metric: string;
    metrics: string[];
  };
  duplicate_categories: Record<string, boolean>;
  methodology: {
    summary: string;
  };
  pairs: RubricPair[];
}

interface ThresholdResult {
  threshold: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  true_negatives: number;
  precision: number;
  recall: number;
  f1: number;
}

interface EvalResult {
  case_id: string;
  benchmark_version: string;
  run_dir: string;
  total_pairs: number;
  unique_claims_embedded: number;
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number;
  threshold_results: ThresholdResult[];
  success: boolean;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const repoRoot = findRepoRoot(import.meta.url);
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  mkdirSync(runDir, { recursive: true });

  const seedPath = resolve(repoRoot, "evals/cases/claim-dedupe-threshold-calibration/seed-claims.json");
  const rubricPath = resolve(repoRoot, "evals/cases/claim-dedupe-threshold-calibration/rubric.json");

  const seedClaims = readJson<ClaimRecord[]>(seedPath);
  const rubric = readJson<Rubric>(rubricPath);

  // Use the same claim-document representation that proposal validation compares
  // against persisted graph-object embeddings.
  const claimMap = new Map(
    buildClaimDocuments({
      components: [],
      flows: [],
      claims: seedClaims.map((claim) => ({
        ...claim,
        kind: "fact",
        truth: "source_verified",
        intent: "intended",
      })),
      sources: [],
      edges: [],
    }).map((document) => [document.id, document.text]),
  );

  // Verify every pair references valid claim IDs
  const missingIds = new Set<string>();
  for (const pair of rubric.pairs) {
    if (!claimMap.has(pair.candidate)) missingIds.add(pair.candidate);
    if (!claimMap.has(pair.existing)) missingIds.add(pair.existing);
  }
  if (missingIds.size > 0) {
    throw new Error(
      `Rubric references claim IDs not found in seed-claims.json: ${[...missingIds].join(", ")}`,
    );
  }

  // Collect unique claim texts to embed
  const uniqueIds = new Set<string>();
  for (const pair of rubric.pairs) {
    uniqueIds.add(pair.candidate);
    uniqueIds.add(pair.existing);
  }

  const uniqueClaimIds = [...uniqueIds];
  const uniqueTexts = uniqueClaimIds.map((id) => claimMap.get(id) as string);

  // Create embedder and embed all unique claims
  const embeddingConfig = graphContextConfig.embedding;
  const embedder = createEmbedder(embeddingConfig);

  console.log(`Embedding ${uniqueClaimIds.length} unique claims with ${embeddingConfig.provider}/${embeddingConfig.model}...`);

  const embeddingVectors = await embedder.embedBatch(uniqueTexts);

  // Build embedding cache
  const embeddingCache = new Map<string, number[]>();
  for (let index = 0; index < uniqueClaimIds.length; index++) {
    embeddingCache.set(uniqueClaimIds[index] as string, embeddingVectors[index] as number[]);
  }

  console.log("Embedding complete.");

  // Determine which categories are considered duplicates
  const duplicateCategories = rubric.duplicate_categories;

  // Evaluate each threshold
  const thresholds = rubric.evaluation.thresholds;
  const thresholdResults: ThresholdResult[] = [];

  for (const threshold of thresholds) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const pair of rubric.pairs) {
      const candidateVector = embeddingCache.get(pair.candidate) as number[];
      const existingVector = embeddingCache.get(pair.existing) as number[];

      const similarity = cosineSimilarity(candidateVector, existingVector);
      const predicted = similarity >= threshold;
      const expected = duplicateCategories[pair.expected] === true;

      if (predicted && expected) {
        tp++;
      } else if (predicted && !expected) {
        fp++;
      } else if (!predicted && expected) {
        fn++;
      } else {
        tn++;
      }
    }

    const precision = tp + fp > 0 ? round(tp / (tp + fp), 4) : 0;
    const recall = tp + fn > 0 ? round(tp / (tp + fn), 4) : 0;
    const f1 = precision + recall > 0 ? round(2 * (precision * recall) / (precision + recall), 4) : 0;

    thresholdResults.push({
      threshold,
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      true_negatives: tn,
      precision,
      recall,
      f1,
    });
  }

  // Print results table
  console.log("");
  console.log("Threshold  Precision  Recall     F1         TP   FP   FN   TN");
  console.log("---------  ---------  ---------  ---------  ---  ---  ---  ---");
  for (const result of thresholdResults) {
    console.log(
      `${result.threshold.toFixed(2).padStart(9)}  ` +
      `${result.precision.toFixed(4).padStart(9)}  ` +
      `${result.recall.toFixed(4).padStart(9)}  ` +
      `${result.f1.toFixed(4).padStart(9)}  ` +
      `${String(result.true_positives).padStart(3)}  ` +
      `${String(result.false_positives).padStart(3)}  ` +
      `${String(result.false_negatives).padStart(3)}  ` +
      `${String(result.true_negatives).padStart(3)}`,
    );
  }
  console.log("");
  const success = thresholdResults.some((r) => r.f1 > 0);

  const result: EvalResult = {
    case_id: caseId,
    benchmark_version: rubric.benchmark_version,
    run_dir: runDir,
    total_pairs: rubric.pairs.length,
    unique_claims_embedded: uniqueClaimIds.length,
    embedding_provider: embeddingConfig.provider,
    embedding_model: embeddingConfig.model,
    embedding_dimensions: embeddingConfig.dimensions,
    threshold_results: thresholdResults,
    success,
  };

  writeJson(resolve(runDir, "result.json"), result);

  console.log("");
  console.log(success ? "Threshold calibration eval passed." : "Threshold calibration eval failed.");
  console.log(`Run directory: ${runDir}`);
  process.exitCode = success ? 0 : 1;
}
