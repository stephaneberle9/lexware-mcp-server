import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Detects whether a thrown error is an HTTP 404 from lexwareRequest.
// lexwareRequest wraps AxiosErrors as `new Error(msg, { cause: axiosError })`,
// so the original response status is on err.cause.response.status.
function is404(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = err.cause as { response?: { status?: number } } | undefined;
  if (cause?.response?.status === 404) return true;
  return /\b404\b/.test(err.message);
}

// Retries fn on 404 errors and empty responses (null / "") — the two signals
// that Lexware hasn't finished indexing a freshly uploaded resource.
// Non-404 errors are re-thrown immediately without retrying.
// delayMs is overridable so unit tests can pass [0,0,0] for instant execution.
export async function withProcessingRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = [1_000, 2_000, 4_000],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await fn();
      if ((result === null || result === '') && attempt < retries - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs[attempt] ?? 4_000));
        continue;
      }
      return result;
    } catch (err) {
      if (is404(err)) {
        lastError = err;
        if (attempt < retries - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs[attempt] ?? 4_000));
          continue;
        }
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

export function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function formatResponse(data: unknown): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
  // GOTCHA: DELETE responses return empty strings (204). Only set structuredContent for objects.
  if (data !== null && typeof data === 'object') {
    result.structuredContent = data as Record<string, unknown>;
  }
  return result;
}

// GOTCHA: Must use `any` — Record<string,unknown> makes destructured props `unknown`,
// breaking template literals like `/invoices/${id}`. Zod validates at runtime anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleToolRequest(fn: (params: any) => Promise<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (params: any) => {
    try {
      const data = await fn(params);
      return formatResponse(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lexware-mcp] Tool error: ${message}`);
      return toolError(err);
    }
  };
}
