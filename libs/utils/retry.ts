export interface RetryOptions {
  maxAttempts: number;
  baseDelay: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delay: number) => void;
}

export class HttpRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxAttempts, baseDelay, shouldRetry, onRetry } = options;

  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt < maxAttempts && shouldRetry(error)) {
        const jitter = Math.random() * 1000;
        const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
        if (onRetry) {
          onRetry(attempt, error, delay);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}
