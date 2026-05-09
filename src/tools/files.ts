import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lexwareRequest, lexwareUpload, lexwareDownload } from '../services/lexware.js';
import { handleToolRequest } from '../helpers.js';
import { UuidSchema } from '../schemas/common.js';

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
      'Upload a file to Lexware. Provide either filePath (absolute path on the MCP server host) or ' +
      'contentBase64 (base64-encoded content) — not both. When using filePath, fileName is optional ' +
      '(derived from the file name) and contentType is auto-detected for common image extensions. ' +
      'When using contentBase64, fileName is required.',
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

    return lexwareUpload('/files', buffer, resolvedFileName, resolvedContentType);
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
