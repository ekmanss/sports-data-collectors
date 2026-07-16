#!/usr/bin/env node

import { writeFiveEPlayMatchMarkdown } from './write_markdown.js';

function usage(): string {
  return [
    '用法：',
    '  5eplay-match-md <比赛URL或ID> <输出.md或输出目录>',
    '',
    '示例：',
    "  5eplay-match-md 'https://event.5eplay.com/csgo/matches/csgo_mc_2395709' './outputs/report.md'",
    "  5eplay-match-md 'csgo_mc_2395709' './outputs'",
  ].join('\n');
}

const rawArguments = process.argv.slice(2);
const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
if (arguments_.includes('--help') || arguments_.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (arguments_.length !== 2) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

const [input, target] = arguments_ as [string, string];
try {
  const written = await writeFiveEPlayMatchMarkdown(input, target, {
    timeoutMs: 30_000,
    onProgress: (event) => process.stderr.write(`[${event.stage}] ${event.message}\n`),
  });
  process.stdout.write(`${JSON.stringify({
    outputPath: written.outputPath,
    bytes: written.bytes,
    matchId: written.result.data.match.id,
    status: written.result.data.match.status,
    maps: written.result.data.maps.length,
  }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`生成 5EPlay Markdown 失败：${message}\n`);
  process.exitCode = 1;
}
