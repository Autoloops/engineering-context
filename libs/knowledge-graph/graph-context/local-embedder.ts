import { join } from "node:path";
import type { EmbeddingConfig } from "../../config/greplica-config.js";
import { greplicaHome } from "../../config/greplica-home.js";
import type { Embedder } from "./embedder.js";
import { withLocalModelLock } from "./local-model-lock.js";

interface TensorLike {
  data: Float32Array | number[];
  dims: number[];
}

type FeatureExtractionPipeline = (
  input: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<TensorLike>;

const localModelAliases: Record<string, string> = {
  "all-mpnet-base-v2": "Xenova/all-mpnet-base-v2",
  "all-MiniLM-L6-v2": "Xenova/all-MiniLM-L6-v2",
};

export class LocalEmbedder implements Embedder {
  private extractor: Promise<FeatureExtractionPipeline> | undefined;
  private readonly modelId: string;
  private readonly cacheDir: string;

  constructor(private readonly options: EmbeddingConfig) {
    this.modelId = resolveLocalModelId(options.model);
    this.cacheDir = join(greplicaHome(), "models");
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    if (!embedding) throw new Error("Local embedding model returned no embedding for query.");
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (let index = 0; index < texts.length; index += this.options.batchSize) {
      embeddings.push(...(await this.embedChunk(texts.slice(index, index + this.options.batchSize))));
    }
    return embeddings;
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.loadExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return splitTensorRows(output, texts.length, this.options.dimensions, this.modelId);
  }

  private async loadExtractor(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= loadFeatureExtractionPipeline(this.options, this.modelId, this.cacheDir);
    return this.extractor;
  }
}

async function loadFeatureExtractionPipeline(config: EmbeddingConfig, modelId: string, cacheDir: string): Promise<FeatureExtractionPipeline> {
  const result = await withLocalModelLock(config, { wait: true }, () => loadFeatureExtractionPipelineUnlocked(modelId, cacheDir));
  if (!result.value) throw new Error(`Local embedding model ${modelId} could not be loaded.`);
  return result.value;
}

async function loadFeatureExtractionPipelineUnlocked(modelId: string, cacheDir: string): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import("@huggingface/transformers");
  const options = {
    cache_dir: cacheDir,
    dtype: "q8",
  } as const;

  try {
    return await pipeline("feature-extraction", modelId, {
      ...options,
      local_files_only: true,
    }) as FeatureExtractionPipeline;
  } catch {
    return pipeline("feature-extraction", modelId, options) as Promise<FeatureExtractionPipeline>;
  }
}

function resolveLocalModelId(model: string): string {
  return localModelAliases[model] ?? model;
}

function splitTensorRows(output: TensorLike, expectedRows: number, expectedDimensions: number, modelId: string): number[][] {
  const [rows, dimensions] = output.dims;
  if (rows !== expectedRows || dimensions !== expectedDimensions) {
    throw new Error(
      `Local embedding model ${modelId} returned shape [${output.dims.join(", ")}]; expected [${expectedRows}, ${expectedDimensions}].`,
    );
  }

  const data = output.data;
  const embeddings: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const start = row * dimensions;
    embeddings.push(Array.from(data.slice(start, start + dimensions)));
  }
  return embeddings;
}
