import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { normalizeVoucherStatus } from '../helpers/normalize-voucher-status.js';
import { createServer } from '../server.js';
import { registerVoucherTools } from '../tools/vouchers.js';

const mocks = vi.hoisted(() => ({
  lexwareRequest: vi.fn(),
  lexwareUpload: vi.fn(),
}));

vi.mock('../services/lexware.js', () => ({
  lexwareRequest: mocks.lexwareRequest,
  lexwareUpload: mocks.lexwareUpload,
  lexwareDownload: vi.fn(),
}));

// GOTCHA: McpServer.registerTool has overloaded signatures — use `any` + `.apply()` like smoke.test.ts.
function captureTools(registerFn: (server: ReturnType<typeof createServer>) => void) {
  const server = createServer('test');
  const captured = new Map<string, { schema: z.ZodTypeAny; handler: (params: unknown) => Promise<any> }>();
  const orig = server.registerTool;
  server.registerTool = ((...args: any[]) => {
    const [name, config, handler] = args;
    captured.set(name, { schema: config.inputSchema, handler });
    return (orig as any).apply(server, args);
  }) as typeof server.registerTool;
  registerFn(server);
  return captured;
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ─── normalizeVoucherStatus ───────────────────────────────────────────────────

describe('normalizeVoucherStatus', () => {
  it.each([
    'unchecked', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit',
  ])('returns %s unchanged (already canonical)', (status) => {
    expect(normalizeVoucherStatus(status)).toBe(status);
  });

  it.each([
    ['OPEN',        'open'],
    ['Open',        'open'],
    ['PAID',        'paid'],
    ['UNCHECKED',   'unchecked'],
    ['PaidOff',     'paidoff'],
    ['VOIDED',      'voided'],
    ['Transferred', 'transferred'],
    ['SepADebit',   'sepadebit'],
  ])('normalises %s → %s (case-insensitive)', (input, expected) => {
    expect(normalizeVoucherStatus(input)).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeVoucherStatus('  open  ')).toBe('open');
    expect(normalizeVoucherStatus('\tPAID\n')).toBe('paid');
  });

  it('lowercases unknown values as a best-effort fallback', () => {
    expect(normalizeVoucherStatus('UNKNOWN')).toBe('unknown');
    expect(normalizeVoucherStatus('CustomStatus')).toBe('customstatus');
  });
});

// ─── lexware_get_voucher ──────────────────────────────────────────────────────

describe('lexware_get_voucher', () => {
  let handler: (params: unknown) => Promise<any>;

  beforeEach(() => {
    mocks.lexwareRequest.mockReset();
    handler = captureTools(registerVoucherTools).get('lexware_get_voucher')!.handler;
  });

  it('calls the correct endpoint', async () => {
    mocks.lexwareRequest.mockResolvedValue({ id: VALID_UUID, version: 1 });
    await handler({ id: VALID_UUID });
    expect(mocks.lexwareRequest).toHaveBeenCalledWith('GET', `/vouchers/${VALID_UUID}`);
  });

  it('normalises voucherStatus to lowercase', async () => {
    mocks.lexwareRequest.mockResolvedValue({ id: VALID_UUID, version: 1, voucherStatus: 'OPEN' });
    const result = await handler({ id: VALID_UUID });
    expect((result as any).structuredContent.voucherStatus).toBe('open');
  });

  it('renames status → voucherStatus when voucherStatus is absent', async () => {
    mocks.lexwareRequest.mockResolvedValue({ id: VALID_UUID, version: 1, status: 'PAID' });
    const result = await handler({ id: VALID_UUID });
    const sc = (result as any).structuredContent;
    expect(sc.voucherStatus).toBe('paid');
    expect(sc.status).toBeUndefined();
  });

  it('removes the status field even when voucherStatus was the source', async () => {
    mocks.lexwareRequest.mockResolvedValue({
      id: VALID_UUID, version: 1,
      voucherStatus: 'open',
      status: 'OPEN', // redundant field that some API versions include
    });
    const result = await handler({ id: VALID_UUID });
    const sc = (result as any).structuredContent;
    expect(sc.voucherStatus).toBe('open');
    expect(sc.status).toBeUndefined();
  });

  it('normalises null voucherStatus by falling back to status', async () => {
    mocks.lexwareRequest.mockResolvedValue({ id: VALID_UUID, version: 1, voucherStatus: null, status: 'VOIDED' });
    const result = await handler({ id: VALID_UUID });
    expect((result as any).structuredContent.voucherStatus).toBe('voided');
  });

  it('passes through response unchanged when no status field is present', async () => {
    const data = { id: VALID_UUID, version: 1, voucherNumber: 'RE-001' };
    mocks.lexwareRequest.mockResolvedValue(data);
    const result = await handler({ id: VALID_UUID });
    expect((result as any).structuredContent).toEqual(data);
  });

  it('preserves all other fields in the response', async () => {
    mocks.lexwareRequest.mockResolvedValue({
      id: VALID_UUID, version: 2,
      voucherStatus: 'PAID',
      voucherNumber: 'RE-2024-001',
      totalGrossAmount: 119.0,
    });
    const sc = (await handler({ id: VALID_UUID }) as any).structuredContent;
    expect(sc.voucherNumber).toBe('RE-2024-001');
    expect(sc.totalGrossAmount).toBe(119.0);
    expect(sc.version).toBe(2);
  });
});

// ─── lexware_list_vouchers ────────────────────────────────────────────────────

describe('lexware_list_vouchers', () => {
  let handler: (params: unknown) => Promise<any>;

  beforeEach(() => {
    mocks.lexwareRequest.mockReset();
    mocks.lexwareRequest.mockResolvedValue({ content: [], totalElements: 0 });
    handler = captureTools(registerVoucherTools).get('lexware_list_vouchers')!.handler;
  });

  it('normalises voucherStatus filter to lowercase', async () => {
    await handler({ voucherStatus: 'OPEN' });
    expect(mocks.lexwareRequest).toHaveBeenCalledWith(
      'GET', '/vouchers', undefined,
      expect.objectContaining({ voucherStatus: 'open' }),
    );
  });

  it('passes undefined when voucherStatus is omitted', async () => {
    await handler({});
    expect(mocks.lexwareRequest).toHaveBeenCalledWith(
      'GET', '/vouchers', undefined,
      expect.objectContaining({ voucherStatus: undefined }),
    );
  });

  it.each([
    ['UNCHECKED',   'unchecked'],
    ['Paid',        'paid'],
    ['PaidOff',     'paidoff'],
    ['VOIDED',      'voided'],
    ['Transferred', 'transferred'],
    ['SepADebit',   'sepadebit'],
  ])('normalises filter %s → %s', async (input, expected) => {
    await handler({ voucherStatus: input });
    expect(mocks.lexwareRequest).toHaveBeenCalledWith(
      'GET', '/vouchers', undefined,
      expect.objectContaining({ voucherStatus: expected }),
    );
  });

  it('passes voucherNumber and size to the API, always starting from page 0', async () => {
    await handler({ size: 50, voucherNumber: 'RE-001', voucherStatus: 'open' });
    expect(mocks.lexwareRequest).toHaveBeenCalledWith(
      'GET', '/vouchers', undefined,
      { page: 0, size: 50, voucherNumber: 'RE-001', voucherStatus: 'open' },
    );
  });

  it('defaults to page size 250 when size is omitted', async () => {
    await handler({});
    expect(mocks.lexwareRequest).toHaveBeenCalledWith(
      'GET', '/vouchers', undefined,
      expect.objectContaining({ page: 0, size: 250 }),
    );
  });

  it('returns { content, totalCount, fetchedPages } shape', async () => {
    mocks.lexwareRequest.mockResolvedValue({ content: [{ id: 'v1' }], totalPages: 1 });
    const result = await handler({});
    const sc = (result as any).structuredContent;
    expect(sc.content).toHaveLength(1);
    expect(sc.totalCount).toBe(1);
    expect(sc.fetchedPages).toBe(1);
  });

  it('auto-paginates until totalPages is exhausted', async () => {
    mocks.lexwareRequest
      .mockResolvedValueOnce({ content: [{ id: 'v1' }, { id: 'v2' }], totalPages: 2 })
      .mockResolvedValueOnce({ content: [{ id: 'v3' }], totalPages: 2 });
    const result = await handler({ size: 2 });
    const sc = (result as any).structuredContent;
    expect(sc.content).toHaveLength(3);
    expect(sc.totalCount).toBe(3);
    expect(sc.fetchedPages).toBe(2);
    expect(mocks.lexwareRequest).toHaveBeenCalledTimes(2);
    expect(mocks.lexwareRequest).toHaveBeenNthCalledWith(1, 'GET', '/vouchers', undefined, expect.objectContaining({ page: 0 }));
    expect(mocks.lexwareRequest).toHaveBeenNthCalledWith(2, 'GET', '/vouchers', undefined, expect.objectContaining({ page: 1 }));
  });
});

// ─── lexware_list_vouchers — client-side filters ───────────────────────────────

describe('lexware_list_vouchers — client-side filters', () => {
  let schema: z.ZodTypeAny;
  let handler: (params: unknown) => Promise<any>;

  const vouchers = [
    { id: 'v1', contactName: 'Müller GmbH',  voucherDate: '2024-01-10', openAmount: 100 },
    { id: 'v2', contactName: 'Büroplus AG',   voucherDate: '2024-03-15', openAmount: 0   },
    { id: 'v3', contactName: 'Müller & Co',   voucherDate: '2024-06-01', openAmount: 50  },
    { id: 'v4', contactName: 'Technik GmbH',  voucherDate: '2024-08-20', openAmount: 200 },
  ];

  beforeEach(() => {
    mocks.lexwareRequest.mockReset();
    mocks.lexwareRequest.mockResolvedValue({ content: vouchers, totalPages: 1 });
    const tool = captureTools(registerVoucherTools).get('lexware_list_vouchers')!;
    schema = tool.schema;
    handler = tool.handler;
  });

  it('contactName % wildcard matches prefix', async () => {
    const sc = (await handler({ contactName: 'Müller%' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v1', 'v3']);
    expect(sc.totalCount).toBe(2);
  });

  it('contactName % wildcard matches suffix', async () => {
    const sc = (await handler({ contactName: '%GmbH' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v1', 'v4']);
  });

  it('contactName _ wildcard matches exactly one char', async () => {
    // 'Müller & Co': the _ matches the single '&' between the two spaces
    const sc = (await handler({ contactName: 'Müller _ Co' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v3']);
  });

  it('contactName filter is case-insensitive', async () => {
    const sc = (await handler({ contactName: 'BÜROPLUS%' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v2']);
  });

  it('voucherDateFrom filters inclusively', async () => {
    const sc = (await handler({ voucherDateFrom: '2024-06-01' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v3', 'v4']);
  });

  it('voucherDateTo filters inclusively', async () => {
    const sc = (await handler({ voucherDateTo: '2024-03-15' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v1', 'v2']);
  });

  it('voucherDateFrom + voucherDateTo form an inclusive range', async () => {
    const sc = (await handler({ voucherDateFrom: '2024-03-15', voucherDateTo: '2024-06-01' }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v2', 'v3']);
  });

  it('hasOpenAmount: true excludes vouchers with openAmount === 0', async () => {
    const sc = (await handler({ hasOpenAmount: true }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v1', 'v3', 'v4']);
  });

  it('multiple filters combine as AND', async () => {
    const sc = (await handler({ contactName: 'Müller%', hasOpenAmount: true }) as any).structuredContent;
    expect(sc.content.map((v: any) => v.id)).toEqual(['v1', 'v3']);
  });

  it('returns empty content array when no vouchers match', async () => {
    const sc = (await handler({ contactName: 'Nonexistent%' }) as any).structuredContent;
    expect(sc.content).toEqual([]);
    expect(sc.totalCount).toBe(0);
    expect(sc.isError).toBeUndefined();
  });

  it('rejects voucherDateFrom that is not YYYY-MM-DD', () => {
    expect(schema.safeParse({ voucherDateFrom: 'January 2024' }).success).toBe(false);
  });

  it('rejects voucherDateTo that is not YYYY-MM-DD', () => {
    expect(schema.safeParse({ voucherDateTo: '15.01.2024' }).success).toBe(false);
  });

  it('accepts voucherDateFrom and voucherDateTo in YYYY-MM-DD format', () => {
    expect(schema.safeParse({ voucherDateFrom: '2024-01-15', voucherDateTo: '2024-12-31' }).success).toBe(true);
  });
});

// ─── lexware_get_voucher — retry behavior ─────────────────────────────────────

describe('lexware_get_voucher — retry behavior', () => {
  let handler: (params: unknown) => Promise<any>;

  beforeEach(() => {
    mocks.lexwareRequest.mockReset();
    vi.useFakeTimers();
    handler = captureTools(registerVoucherTools).get('lexware_get_voucher')!.handler;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns processing response after exhausting 3 retries on 404', async () => {
    const err404 = Object.assign(new Error('Not Found'), { cause: { response: { status: 404 } } });
    mocks.lexwareRequest.mockRejectedValue(err404);

    const promise = handler({ id: VALID_UUID });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe('processing');
    expect(result.structuredContent.voucherId).toBe(VALID_UUID);
    expect(result.structuredContent.message).toContain('retry');
    expect(mocks.lexwareRequest).toHaveBeenCalledTimes(3);
  });

  it('returns the voucher on the second attempt after an initial 404', async () => {
    const err404 = Object.assign(new Error('Not Found'), { cause: { response: { status: 404 } } });
    mocks.lexwareRequest
      .mockRejectedValueOnce(err404)
      .mockResolvedValue({ id: VALID_UUID, voucherStatus: 'open', version: 1 });

    const promise = handler({ id: VALID_UUID });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.voucherStatus).toBe('open');
    expect(mocks.lexwareRequest).toHaveBeenCalledTimes(2);
  });

  it('returns processing response for non-404 errors without retrying', async () => {
    mocks.lexwareRequest.mockRejectedValue(new Error('Internal Server Error'));

    const result = await handler({ id: VALID_UUID });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe('processing');
    expect(result.structuredContent.voucherId).toBe(VALID_UUID);
    expect(mocks.lexwareRequest).toHaveBeenCalledTimes(1);
  });
});
