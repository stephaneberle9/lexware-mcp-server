import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  const captured = new Map<string, { handler: (params: unknown) => Promise<any> }>();
  const orig = server.registerTool;
  server.registerTool = ((...args: any[]) => {
    const [name, , handler] = args;
    captured.set(name, { handler });
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

  it('passes pagination and voucherNumber parameters through', async () => {
    await handler({ page: 2, size: 50, voucherNumber: 'RE-001', voucherStatus: 'open' });
    expect(mocks.lexwareRequest).toHaveBeenCalledWith(
      'GET', '/vouchers', undefined,
      { page: 2, size: 50, voucherNumber: 'RE-001', voucherStatus: 'open' },
    );
  });
});
