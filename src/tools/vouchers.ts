import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lexwareRequest, lexwareUpload } from '../services/lexware.js';
import { handleToolRequest, withProcessingRetry } from '../helpers.js';
import { UuidSchema } from '../schemas/common.js';
import { MAX_UPLOAD_BYTES } from '../constants.js';
import { normalizeVoucherStatus } from '../helpers/normalize-voucher-status.js';

const EXT_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

// O(m*n) DP wildcard match — no RegExp construction, immune to ReDoS.
// % matches any sequence of chars, _ matches exactly one char. Case-insensitive.
function wildcardMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  const m = p.length;
  const n = t.length;
  const dp: boolean[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(false));
  dp[0][0] = true;
  for (let i = 1; i <= m; i++) {
    if (p[i - 1] === '%') dp[i][0] = dp[i - 1][0];
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (p[i - 1] === '%') {
        dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
      } else if (p[i - 1] === '_' || p[i - 1] === t[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      }
    }
  }
  return dp[m][n];
}

export function registerVoucherTools(server: McpServer): void {
  server.registerTool('lexware_create_voucher', {
    title: 'Create Voucher',
    description: 'Create a new bookkeeping voucher in Lexware.',
    inputSchema: z.object({
      body: z.record(z.string(), z.unknown()).describe(
        'Voucher JSON. Key fields: type ("salesinvoice"|"salescreditnote"|"purchaseinvoice"|"purchasecreditnote"), voucherNumber, voucherDate, totalGrossAmount, totalTaxAmount, taxType, voucherItems (array), contactId'
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    return lexwareRequest('POST', '/vouchers', params.body);
  }));

  server.registerTool('lexware_get_voucher', {
    title: 'Get Voucher',
    description:
      'Retrieve a bookkeeping voucher by ID from Lexware. ' +
      'The voucherStatus field in the response is normalised to its canonical lowercase form. ' +
      'Known values: unchecked (pending review), open (due for payment), paid, ' +
      'paidoff (settled), voided (cancelled), transferred (posted), sepadebit (SEPA direct debit). ' +
      'Retries up to 3 times (1 s / 2 s / 4 s) on 404 to handle post-upload race conditions. ' +
      'After exhausted retries returns { voucherId, status: "processing", message } instead of an error.',
    inputSchema: z.object({
      id: UuidSchema.describe('Voucher UUID'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    try {
      return await withProcessingRetry(async () => {
        const voucher = await lexwareRequest<Record<string, unknown>>('GET', `/vouchers/${params.id}`);
        // GET /vouchers/{id} may return the status as 'status' while GET /vouchers
        // uses 'voucherStatus'. Normalise to 'voucherStatus' (canonical field name).
        const rawStatus = voucher.voucherStatus ?? voucher.status;
        if (typeof rawStatus === 'string') {
          voucher.voucherStatus = normalizeVoucherStatus(rawStatus);
          delete voucher.status;
        }
        return voucher;
      });
    } catch {
      return {
        voucherId: params.id as string,
        status: 'processing',
        message: 'Voucher is still being processed by Lexware — please retry in 30 seconds.',
      };
    }
  }));

  server.registerTool('lexware_update_voucher', {
    title: 'Update Voucher',
    description: 'Update an existing bookkeeping voucher in Lexware. Requires version field for optimistic locking.',
    inputSchema: z.object({
      id: UuidSchema.describe('Voucher UUID'),
      body: z.record(z.string(), z.unknown()).describe('Voucher JSON with version field for optimistic locking'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    return lexwareRequest('PUT', `/vouchers/${params.id}`, params.body);
  }));

  server.registerTool('lexware_list_vouchers', {
    title: 'List Vouchers',
    description:
      'List bookkeeping vouchers from Lexware with optional filters. ' +
      'Automatically fetches all pages and applies client-side filters for contactName, ' +
      'voucherDateFrom, voucherDateTo, and hasOpenAmount. ' +
      'voucherStatus filter values (case-insensitive): unchecked (pending review), ' +
      'open (due for payment), paid, paidoff (settled), voided (cancelled), ' +
      'transferred (posted), sepadebit (SEPA direct debit). ' +
      'Returns { content, totalCount, fetchedPages }.',
    inputSchema: z.object({
      size: z.number().int().min(1).max(250).optional().describe(
        'Results per API request (default 250). Controls fetch batch size, not result count.'
      ),
      voucherNumber: z.string().optional().describe('Filter by voucher number (API-side)'),
      voucherStatus: z.string().optional().describe(
        'Filter by voucher status (API-side). Accepted values: unchecked, open, paid, paidoff, voided, transferred, sepadebit. Case-insensitive.'
      ),
      contactName: z.string().optional().describe(
        'Wildcard filter on contactName (client-side). % = any chars, _ = any single char. Case-insensitive. Example: "Müller%".'
      ),
      voucherDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Must be YYYY-MM-DD').optional().describe(
        'Include only vouchers with voucherDate >= this date (inclusive). Format: YYYY-MM-DD.'
      ),
      voucherDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Must be YYYY-MM-DD').optional().describe(
        'Include only vouchers with voucherDate <= this date (inclusive). Format: YYYY-MM-DD.'
      ),
      hasOpenAmount: z.boolean().optional().describe(
        'When true, include only vouchers with openAmount > 0.'
      ),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    const pageSize = params.size ?? 250;
    let page = 0;
    let totalPages = 1;
    const allVouchers: Record<string, unknown>[] = [];

    while (page < totalPages) {
      const response = await lexwareRequest<{ content: Record<string, unknown>[]; totalPages: number }>(
        'GET', '/vouchers', undefined,
        {
          voucherNumber: params.voucherNumber,
          voucherStatus: params.voucherStatus ? normalizeVoucherStatus(params.voucherStatus) : undefined,
          page,
          size: pageSize,
        },
      );
      allVouchers.push(...(response.content ?? []));
      totalPages = response.totalPages ?? 1;
      page++;
    }

    const fetchedPages = page;
    let filtered = allVouchers;

    if (params.contactName) {
      const pattern = params.contactName;
      filtered = filtered.filter((v) => typeof v.contactName === 'string' && wildcardMatch(pattern, v.contactName));
    }

    if (params.voucherDateFrom) {
      const from = params.voucherDateFrom;
      filtered = filtered.filter((v) => typeof v.voucherDate === 'string' && v.voucherDate >= from);
    }

    if (params.voucherDateTo) {
      const to = params.voucherDateTo;
      filtered = filtered.filter((v) => typeof v.voucherDate === 'string' && v.voucherDate <= to);
    }

    if (params.hasOpenAmount === true) {
      filtered = filtered.filter((v) => typeof v.openAmount === 'number' && v.openAmount > 0);
    }

    return { content: filtered, totalCount: filtered.length, fetchedPages };
  }));

  server.registerTool('lexware_upload_voucher_file', {
    title: 'Upload Voucher File',
    description:
      'Upload a file attachment to a bookkeeping voucher. Maximum file size: 5 MB (returns file_too_large error immediately if exceeded). ' +
      'Provide either filePath (absolute path on the MCP server host) or contentBase64 (base64-encoded content) — not both. ' +
      'When using filePath, fileName is optional (derived from the file name) and contentType is auto-detected for common image extensions. ' +
      'When using contentBase64, fileName is required.',
    inputSchema: z
      .object({
        id: UuidSchema.describe('Voucher UUID'),
        filePath: z
          .string()
          .optional()
          .describe('Absolute path to the file on the MCP server host. Must be readable by the MCP server process.'),
        contentBase64: z
          .string()
          .optional()
          .describe('Base64-encoded file content. Required when filePath is not provided.'),
        fileName: z
          .string()
          .optional()
          .describe('File name for the upload. Required when using contentBase64; derived from filePath when omitted.'),
        contentType: z
          .string()
          .optional()
          .describe(
            'MIME type (e.g. application/pdf, image/png). Defaults to application/pdf. ' +
            'Auto-detected from filePath extension for .png, .jpg/.jpeg, .tiff/.tif.'
          ),
      })
      .refine((data) => !!(data.filePath) !== !!(data.contentBase64), {
        message: 'Exactly one of filePath or contentBase64 must be provided',
      })
      .refine((data) => !(data.contentBase64 && !data.fileName), {
        message: 'fileName is required when using contentBase64',
      }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    let buffer: Buffer;
    let resolvedFileName: string;
    let resolvedContentType: string;

    if (params.filePath) {
      if (!path.isAbsolute(params.filePath)) {
        throw new Error(`filePath must be absolute, got: ${params.filePath}`);
      }
      let resolved: string;
      try {
        resolved = fs.realpathSync(params.filePath);
      } catch (err) {
        throw new Error(`Cannot resolve filePath "${params.filePath}": ${(err as NodeJS.ErrnoException).message}`);
      }
      try {
        fs.accessSync(resolved, fs.constants.R_OK);
      } catch (err) {
        throw new Error(`File not readable at "${resolved}": ${(err as NodeJS.ErrnoException).message}`);
      }
      buffer = fs.readFileSync(resolved);
      resolvedFileName = params.fileName ?? path.basename(resolved);
      const ext = path.extname(resolved).toLowerCase();
      resolvedContentType = params.contentType ?? EXT_CONTENT_TYPES[ext] ?? 'application/pdf';
    } else {
      buffer = Buffer.from(params.contentBase64!, 'base64');
      resolvedFileName = params.fileName!;
      resolvedContentType = params.contentType ?? 'application/pdf';
    }

    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(JSON.stringify({
        error: 'file_too_large',
        actualSize: buffer.byteLength,
        maxSize: MAX_UPLOAD_BYTES,
        suggestion: 'Compress the PDF or re-scan at lower DPI to reduce file size below 5 MB',
      }));
    }

    return lexwareUpload(`/vouchers/${params.id}/files`, buffer, resolvedFileName, resolvedContentType);
  }));
}
