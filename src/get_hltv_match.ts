import { setTimeout as delay } from 'node:timers/promises';
import { buildConsumerFromCaptureData } from './transform/build_consumer.js';
import { captureMatch } from './capture/capture_match.js';
import { emitProgress, normalizeOptions, throwIfAborted } from './config.js';
import { HltvMatchError, asHltvMatchError } from './errors.js';
import { renderChineseReport } from './reports/render_chinese_report.js';
import { renderMarkdown } from './reports/render_markdown.js';
import { createStage, discardStage, publishStage, writeCaptureArtifacts, writeFailure, writeFormalOutputs } from './storage/publish_outputs.js';
import { validateMatch } from './transform/validate_match.js';
import type {
  CaptureAttempt, GetHltvMatchOptions, GetHltvMatchResult, MatchDiagnostics, MatchFiles,
} from './types.js';

function progress(
  options: ReturnType<typeof normalizeOptions>,
  failures: string[],
  stage: Parameters<typeof emitProgress>[1]['stage'],
  attempt: number,
  message: string,
): void {
  const failure = emitProgress(options, { stage, attempt, message });
  if (failure) failures.push(failure);
}

async function retryDelay(options: ReturnType<typeof normalizeOptions>): Promise<void> {
  throwIfAborted(options, 'navigating');
  const milliseconds = 2_000 + Math.floor(Math.random() * 501);
  try {
    await delay(milliseconds, undefined, { signal: options.signal });
  } catch (cause) {
    if (options.signal?.aborted) {
      throw new HltvMatchError('capture was aborted', {
        code: 'ABORTED', stage: 'navigating', retryable: false, matchId: String(options.id), slug: options.slug, cause,
      });
    }
    throw cause;
  }
}

export async function getHltvMatch(input: GetHltvMatchOptions): Promise<GetHltvMatchResult> {
  const progressFailures: string[] = [];
  const reporter = input.onProgress;
  const options = normalizeOptions({
    ...input,
    onProgress: reporter ? (event) => {
      try {
        reporter(event);
      } catch (error) {
        progressFailures.push(error instanceof Error ? error.message : String(error));
      }
    } : undefined,
  });
  progress(options, progressFailures, 'validating-input', 1, 'Validated match ID, slug, and options');
  const attempts: MatchDiagnostics['attempts'] = [];
  let capture: CaptureAttempt | null = null;
  let stageFiles: MatchFiles | null = null;

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = new Date().toISOString();
      try {
        capture = await captureMatch(options, attempt);
        attempts.push({
          attempt, startedAt: capture.startedAt, completedAt: capture.completedAt,
          httpStatus: capture.page.http_status,
        });
        break;
      } catch (error) {
        const normalized = asHltvMatchError(error, {
          code: 'INTERNAL_ERROR', stage: 'extracting-page', retryable: false,
          matchId: String(options.id), slug: options.slug,
        });
        attempts.push({
          attempt, startedAt, completedAt: new Date().toISOString(),
          httpStatus: typeof normalized.details?.httpStatus === 'number' ? normalized.details.httpStatus : null,
          error: { code: normalized.code, message: normalized.message },
        });
        if (!normalized.retryable || attempt === 2) throw normalized;
        progress(options, progressFailures, 'navigating', attempt, 'Transient failure; retrying once');
        await retryDelay(options);
      }
    }
    if (!capture) throw new HltvMatchError('capture produced no result', { code: 'INTERNAL_ERROR', stage: 'extracting-page', retryable: false });

    progress(options, progressFailures, 'building-output', capture.attempt, 'Building schema 2.1.0 consumer data');
    const latestPage = { ...capture.page, extracted: capture.snapshot.page };
    const mapName = capture.snapshot.scoreboardNormal?.round.split(' - ').slice(1).join(' - ').trim() || 'unknown';
    const liveFile = `${mapName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'}.json`;
    const { consumer: data, diagnostics } = await buildConsumerFromCaptureData(
      latestPage,
      capture.page,
      capture.snapshot,
      capture.snapshot,
      [capture.snapshot],
      [liveFile],
      { id: options.id, slug: options.slug, url: options.url, attempts },
    );
    let recordedProgressFailures = 0;
    const appendProgressWarnings = (): void => {
      for (const message of progressFailures.slice(recordedProgressFailures)) diagnostics.warnings.push({
        code: 'PROGRESS_HANDLER_FAILED', reason: message,
      });
      recordedProgressFailures = progressFailures.length;
    };
    appendProgressWarnings();
    let markdown = renderMarkdown(data, diagnostics);
    let chineseReport = renderChineseReport(data, diagnostics);

    progress(options, progressFailures, 'validating-output', capture.attempt, 'Validating identity, completeness, consistency, and safety');
    appendProgressWarnings();
    markdown = renderMarkdown(data, diagnostics);
    chineseReport = renderChineseReport(data, diagnostics);
    validateMatch(data, diagnostics, latestPage.extracted, options, markdown, chineseReport);

    let files: MatchFiles | null = null;
    if (options.writeFiles) {
      progress(options, progressFailures, 'publishing-files', capture.attempt, 'Writing and atomically publishing outputs');
      try {
        appendProgressWarnings();
        markdown = renderMarkdown(data, diagnostics);
        chineseReport = renderChineseReport(data, diagnostics);
        validateMatch(data, diagnostics, latestPage.extracted, options, markdown, chineseReport);
        stageFiles = await createStage(options);
        await writeCaptureArtifacts(stageFiles, capture);
        await writeFormalOutputs(stageFiles, data, markdown, chineseReport, diagnostics);
        files = await publishStage(options, stageFiles);
        stageFiles = null;
      } catch (cause) {
        throw new HltvMatchError('failed to publish match outputs', {
          code: 'OUTPUT_ERROR', stage: 'publishing-files', retryable: false,
          matchId: String(options.id), slug: options.slug, cause,
        });
      }
    }
    progress(options, progressFailures, 'completed', capture.attempt, 'Capture completed');
    return { data, markdown, chineseReport, diagnostics, files };
  } catch (error) {
    const normalized = asHltvMatchError(error, {
      code: 'INTERNAL_ERROR', stage: 'building-output', retryable: false,
      matchId: String(options.id), slug: options.slug,
    });
    await discardStage(stageFiles);
    if (options.writeFiles && normalized.code !== 'INVALID_INPUT') {
      await writeFailure(options, {
        code: normalized.code, stage: normalized.stage, message: normalized.message, retryable: normalized.retryable,
      }, capture).catch(() => undefined);
    }
    throw normalized;
  }
}
