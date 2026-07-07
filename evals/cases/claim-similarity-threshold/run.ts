import { graphContextConfig } from "../../../libs/knowledge-graph/graph-context/config.js";
import { createEmbedder } from "../../../libs/knowledge-graph/graph-context/embedder.js";
import { cosineSimilarity } from "../../../libs/knowledge-graph/graph-context/vector.js";

type Label = "duplicate" | "distinct";

interface LabeledPair {
  id: string;
  label: Label;
  left: string;
  right: string;
  category: "exact_duplicate" | "paraphrase" | "related_but_distinct" | "unrelated";
}

interface ThresholdScore {
  threshold: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  true_negatives: number;
}

const pairs: LabeledPair[] = [
  {
    id: "exact_duplicate",
    label: "duplicate",
    category: "exact_duplicate",
    left: "computeTotal applies a flat 5% discount.",
    right: "computeTotal applies a flat 5% discount.",
  },
  {
    id: "paraphrase_duplicate",
    label: "duplicate",
    category: "paraphrase",
    left: "computeTotal applies a flat 5% discount.",
    right: "computeTotal subtracts five percent from the input amount.",
  },
  {
    id: "related_distinct_tax",
    label: "distinct",
    category: "related_but_distinct",
    left: "computeTotal applies a flat 5% discount.",
    right: "computeTotal applies sales tax after calculating the subtotal.",
  },
  {
    id: "related_distinct_validation",
    label: "distinct",
    category: "related_but_distinct",
    left: "Proposal validation requires evidenced_by edges to include metadata.reason.",
    right: "Proposal apply creates embeddings after writing proposal records.",
  },
  {
    id: "unrelated_graph_view",
    label: "distinct",
    category: "unrelated",
    left: "computeTotal applies a flat 5% discount.",
    right: "The graph view renders claim freshness charts in the browser.",
  },
];

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const embedder = createEmbedder(graphContextConfig.embedding);
  const texts = [...new Set(pairs.flatMap((pair) => [pair.left, pair.right]))];
  const vectors = await embedder.embedBatch(texts);
  const vectorByText = new Map(texts.map((text, index) => [text, vectors[index] ?? []]));
  const scoredPairs = pairs.map((pair) => ({
    ...pair,
    score: cosineSimilarity(requiredVector(vectorByText, pair.left), requiredVector(vectorByText, pair.right)),
  }));

  const sweep = thresholdSweep(scoredPairs);
  const configured = scoreThreshold(scoredPairs, graphContextConfig.similarClaims.threshold);
  const bestLowFalsePositive = [...sweep]
    .filter((score) => score.false_positives === 0)
    .sort((left, right) =>
      right.true_positives - left.true_positives ||
      left.false_negatives - right.false_negatives ||
      left.threshold - right.threshold,
    )[0];

  console.log(JSON.stringify({
    model: graphContextConfig.embedding.model,
    configured_threshold: graphContextConfig.similarClaims.threshold,
    configured,
    best_low_false_positive_threshold: bestLowFalsePositive,
    pairs: scoredPairs.map((pair) => ({
      id: pair.id,
      category: pair.category,
      label: pair.label,
      score: round(pair.score),
    })),
  }, null, 2));

  if (configured.false_positives > 0) {
    throw new Error(`Configured threshold ${graphContextConfig.similarClaims.threshold} produced false positives on distinct claim pairs.`);
  }
}

function thresholdSweep(scoredPairs: Array<LabeledPair & { score: number }>): ThresholdScore[] {
  const scores: ThresholdScore[] = [];
  for (let raw = 70; raw <= 99; raw += 1) {
    scores.push(scoreThreshold(scoredPairs, raw / 100));
  }
  return scores;
}

function scoreThreshold(
  scoredPairs: Array<LabeledPair & { score: number }>,
  threshold: number,
): ThresholdScore {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  for (const pair of scoredPairs) {
    const flagged = pair.score >= threshold;
    if (flagged && pair.label === "duplicate") truePositives += 1;
    else if (flagged && pair.label === "distinct") falsePositives += 1;
    else if (!flagged && pair.label === "duplicate") falseNegatives += 1;
    else trueNegatives += 1;
  }
  return {
    threshold: round(threshold, 2),
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    true_negatives: trueNegatives,
  };
}

function requiredVector(vectors: Map<string, number[]>, text: string): number[] {
  const vector = vectors.get(text);
  if (vector === undefined) throw new Error(`Missing embedding for ${text}`);
  return vector;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
