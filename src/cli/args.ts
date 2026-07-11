import { HltvMatchError } from '../errors.js';

export interface MatchCliArgs {
  id: string;
  slug: string;
  outputRoot?: string;
  headless: boolean;
  pageWaitMs?: number;
  scorebotWaitMs?: number;
}

export const HELP = `Usage:
  pnpm match -- --id <match-id> --slug <match-slug> [options]

Required:
  --id <number>               HLTV match ID
  --slug <slug>               Exact canonical HLTV match slug

Options:
  --output-root <path>        Output root (default: outputs/matches)
  --headed                    Show the CloakBrowser window
  --page-wait-ms <number>     Static-page settle time (default: 12000)
  --scorebot-wait-ms <number> Scorebot settle time (default: 10000)
  --help                      Show this help
`;

function invalid(message: string): never {
  throw new HltvMatchError(message, { code: 'INVALID_INPUT', stage: 'validating-input', retryable: false });
}

export function parseMatchCliArgs(argv: string[]): MatchCliArgs | { help: true } {
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.includes('--help')) {
    if (argv.length !== 1) invalid('--help cannot be combined with other arguments');
    return { help: true };
  }
  const values = new Map<string, string>();
  let headed = false;
  const valued = new Set(['--id', '--slug', '--output-root', '--page-wait-ms', '--scorebot-wait-ms']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--headed') {
      if (headed) invalid('--headed was provided more than once');
      headed = true;
      continue;
    }
    if (!valued.has(flag)) invalid(`unknown argument: ${flag}`);
    if (values.has(flag)) invalid(`${flag} was provided more than once`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) invalid(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const id = values.get('--id');
  const slug = values.get('--slug');
  if (!id || !slug) invalid('--id and --slug are required');
  const numberOption = (flag: string): number | undefined => {
    const raw = values.get(flag);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) invalid(`${flag} must be an integer`);
    return Number(raw);
  };
  return {
    id,
    slug,
    outputRoot: values.get('--output-root'),
    headless: !headed,
    pageWaitMs: numberOption('--page-wait-ms'),
    scorebotWaitMs: numberOption('--scorebot-wait-ms'),
  };
}
