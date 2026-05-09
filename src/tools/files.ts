import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lexwareRequest, lexwareUpload, lexwareDownload } from '../services/lexware.js';
import { handleToolRequest } from '../helpers.js';
import { UuidSchema } from '../schemas/common.js';
import { MAX_UPLOAD_BYTES } from '../constants.js';

const EXT_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

export function registerFileTools(server: McpServer): void {
  server.registerTool('lexware_upload_file', {
    title: 'Upload File',
    description:
      'Upload a file to Lexware. Maximum file size: 5 MB (returns file_too_large error immediately if exceeded). ' +
      'Provide either filePath (absolute path on the MCP server host) or ' +
      'contentBase64 (base64-encoded content) — not both. When using filePath, fileName is optional ' +
      '(derived from the file name) and contentType is auto-detected for common image extensions. ' +
      'When using contentBase64, fileName is required. ' +
      'The response is enriched with file metadata fetched after upload: ' +
      'created (true = freshly created ≤60 s ago; false = pre-existing file — use as duplicate-detection signal; ' +
      'null = Lexware is still processing, status unavailable), ' +
      'voucherStatus, and createdDate (ISO 8601).',
    inputSchema: z
      .object({
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

    const uploadResult = await lexwareUpload<Record<string, unknown>>('/files', buffer, resolvedFileName, resolvedContentType);

    // Extract the file ID — the API may use 'id' (UUID) or 'documentFileId'.
    const fileId = (uploadResult.id ?? uploadResult.documentFileId) as string | undefined;
    if (!fileId) {
      return uploadResult;
    }

    try {
      const fileInfo = await lexwareRequest<Record<string, unknown>>('GET', `/files/${fileId}`);
      const createdDate = (fileInfo.createdDate ?? uploadResult.createdDate) as string | undefined;
      // created: true  → file is ≤60 s old (fresh upload, not a duplicate)
      // created: false → file is older than 60 s (likely a pre-existing duplicate)
      const created = createdDate
        ? Date.now() - new Date(createdDate).getTime() <= 60_000
        : null;
      return { ...uploadResult, ...fileInfo, fileId, created, createdDate: createdDate ?? null };
    } catch {
      // Lexware may still be processing the file — don't fail the whole upload.
      return { ...uploadResult, fileId, created: null, voucherStatus: 'processing' };
    }
  }));

  server.registerTool('lexware_download_file', {
    title: 'Download File',
    description: 'Download a file from Lexware. Returns the file as base64-encoded content.',
    inputSchema: z.object({
      id: UuidSchema.describe('File UUID'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    const file = await lexwareDownload(`/files/${params.id}`);
    return {
      fileName: file.fileName || 'file',
      contentType: file.contentType,
      contentBase64: file.data.toString('base64'),
    };
  }));

  server.registerTool('lexware_get_file_status', {
    title: 'Get File Status',
    description: 'Get file metadata and processing status from Lexware.',
    inputSchema: z.object({
      id: UuidSchema.describe('File UUID'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, handleToolRequest(async (params) => {
    return lexwareRequest('GET', `/files/${params.id}`);
  }));
}
