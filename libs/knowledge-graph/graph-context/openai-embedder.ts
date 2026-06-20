import { HttpRequestError, withRetry } from "../../utils/retry.js";

export interface OpenAIEmbedderOptions {
  apiKey?: string;
  model: string;
  dimensions: number;
  batchSize: number;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  error?: { message?: string };
}

export class OpenAIEmbedder {
  private readonly apiKey: string;

  constructor(private readonly options: OpenAIEmbedderOptions) {
    if (typeof options.batchSize !== "number" || options.batchSize < 1) {
      throw new Error("batchSize must be a positive integer.");
    }
    if (typeof options.dimensions !== "number" || options.dimensions < 1) {
      throw new Error("dimensions must be a positive integer.");
    }
    const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for graph context embeddings. Set it in the environment, target-root .env.local, or target-root .env.");
    }
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    if (!embedding) throw new Error("OpenAI returned no embedding for query.");
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

    return withRetry(
      async () => {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: texts,
            model: this.options.model,
            dimensions: this.options.dimensions,
            encoding_format: "float",
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as OpenAIEmbeddingResponse;
          throw new HttpRequestError(
            response.status,
            response.statusText,
            payload.error?.message ?? response.statusText
          );
        }

        const payload = (await response.json()) as OpenAIEmbeddingResponse;
        if (!Array.isArray(payload.data)) {
          throw new Error("OpenAI embeddings response did not include data.");
        }

        return payload.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => {
            if (item.embedding.length !== this.options.dimensions) {
              throw new Error(`OpenAI returned ${item.embedding.length} dimensions; expected ${this.options.dimensions}.`);
            }
            return item.embedding;
          });
      },
      {
        maxAttempts: 5,
        baseDelay: 1000,
        shouldRetry: (error: unknown) => {
          if (error instanceof HttpRequestError) {
            return error.status === 429 || (error.status >= 500 && error.status < 600);
          }
          if (error instanceof TypeError) {
            return true;
          }
          const err = error as any;
          if (err && typeof err.code === "string") {
            const code = err.code;
            return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND";
          }
          return false;
        },
        onRetry: (attempt: number, error: unknown, delay: number) => {
          const details = error instanceof HttpRequestError
            ? `status ${error.status}`
            : `error: ${error instanceof Error ? error.message : String(error)}`;
          console.warn(
            `OpenAI embeddings request failed with ${details} (attempt ${attempt}/5). Retrying in ${Math.round(delay)}ms...`
          );
        }
      }
    );
  }
}
