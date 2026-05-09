import { describe, it, expect, vi } from 'vitest';
import { toolError, formatResponse, handleToolRequest, withProcessingRetry } from '../helpers.js';

describe('toolError', () => {
  it('returns isError true with Error message', () => {
    const result = toolError(new Error('something broke'));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: something broke' });
  });

  it('returns isError true with string', () => {
    const result = toolError('string error');
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: string error' });
  });
});

describe('formatResponse', () => {
  it('returns JSON text for objects with structuredContent', () => {
    const data = { id: '123', name: 'test' };
    const result = formatResponse(data);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(data, null, 2) });
    expect(result.structuredContent).toEqual(data);
  });

  it('returns text without structuredContent for strings', () => {
    const result = formatResponse('plain text');
    expect(result.content[0]).toEqual({ type: 'text', text: '"plain text"' });
    expect(result.structuredContent).toBeUndefined();
  });

  it('returns text without structuredContent for empty string', () => {
    const result = formatResponse('');
    expect(result.content[0]).toEqual({ type: 'text', text: '""' });
    expect(result.structuredContent).toBeUndefined();
  });

  it('handles null without structuredContent', () => {
    const result = formatResponse(null);
    expect(result.content[0]).toEqual({ type: 'text', text: 'null' });
    expect(result.structuredContent).toBeUndefined();
  });

  it('handles arrays with structuredContent', () => {
    const data = [1, 2, 3];
    const result = formatResponse(data);
    expect(result.structuredContent).toEqual(data);
  });
});

describe('withProcessingRetry', () => {
  function make404(via: 'cause' | 'message' = 'cause'): Error {
    if (via === 'cause') {
      return Object.assign(new Error('Not Found'), { cause: { response: { status: 404 } } });
    }
    return new Error('HTTP 404 Not Found');
  }

  it('returns the result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue({ id: '123' });
    const result = await withProcessingRetry(fn, 3, [0, 0, 0]);
    expect(result).toEqual({ id: '123' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 404 detected via cause.response.status and succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(make404('cause')).mockResolvedValue({ id: 'ok' });
    const result = await withProcessingRetry(fn, 3, [0, 0, 0]);
    expect(result).toEqual({ id: 'ok' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 404 detected via error message and succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(make404('message')).mockResolvedValue({ id: 'ok' });
    const result = await withProcessingRetry(fn, 3, [0, 0, 0]);
    expect(result).toEqual({ id: 'ok' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws non-404 errors immediately without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Internal Server Error'));
    await expect(withProcessingRetry(fn, 3, [0, 0, 0])).rejects.toThrow('Internal Server Error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last 404 error after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(make404());
    await expect(withProcessingRetry(fn, 3, [0, 0, 0])).rejects.toThrow('Not Found');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on null result and returns null on the last attempt', async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const result = await withProcessingRetry(fn, 3, [0, 0, 0]);
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on empty string result and returns empty string on the last attempt', async () => {
    const fn = vi.fn().mockResolvedValue('');
    const result = await withProcessingRetry(fn, 3, [0, 0, 0]);
    expect(result).toBe('');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns successful result after retrying a null response', async () => {
    const fn = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'abc' });
    const result = await withProcessingRetry(fn, 3, [0, 0, 0]);
    expect(result).toEqual({ id: 'abc' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects a custom retries count', async () => {
    const fn = vi.fn().mockRejectedValue(make404());
    await expect(withProcessingRetry(fn, 2, [0, 0])).rejects.toThrow('Not Found');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('handleToolRequest', () => {
  it('wraps successful result with formatResponse', async () => {
    const fn = vi.fn().mockResolvedValue({ id: 'abc' });
    const handler = handleToolRequest(fn);
    const result = await handler({ test: true });
    expect(fn).toHaveBeenCalledWith({ test: true });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id: 'abc' });
  });

  it('catches errors and returns toolError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(new Error('API failed'));
    const handler = handleToolRequest(fn);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: API failed' });
    expect(consoleSpy).toHaveBeenCalledWith('[lexware-mcp] Tool error: API failed');
    consoleSpy.mockRestore();
  });
});
