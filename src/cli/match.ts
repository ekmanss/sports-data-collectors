#!/usr/bin/env node
import { getHltvMatch } from '../get_hltv_match.js';
import { HltvMatchError } from '../errors.js';
import { HELP, parseMatchCliArgs } from './args.js';

try {
  const args = parseMatchCliArgs(process.argv.slice(2));
  if ('help' in args) {
    process.stdout.write(HELP);
  } else {
    const result = await getHltvMatch({
      ...args,
      onProgress: (event) => process.stderr.write(`[${event.stage}] ${event.message}\n`),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      matchId: result.data.match.id,
      slug: result.data.match.slug,
      status: result.data.match.status,
      outputDirectory: result.files?.directory ?? null,
      files: result.files ? {
        json: result.files.json,
        markdown: result.files.markdown,
        chineseReport: result.files.chineseReport,
        diagnostics: result.files.diagnostics,
      } : null,
      warnings: result.diagnostics.warnings.length,
    }, null, 2)}\n`);
  }
} catch (error) {
  const normalized = error instanceof HltvMatchError ? error : new HltvMatchError(
    error instanceof Error ? error.message : String(error),
    { code: 'INTERNAL_ERROR', stage: 'validating-input', retryable: false, cause: error },
  );
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: normalized.code,
      stage: normalized.stage,
      message: normalized.message,
      retryable: normalized.retryable,
    },
  })}\n`);
  process.exitCode = 1;
}
