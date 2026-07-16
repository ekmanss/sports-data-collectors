import { captureFiveEPlayMatch } from './capture.js';
import type {
  GetFiveEPlayMatchOptions,
  GetFiveEPlayMatchResult,
} from './types.js';

export async function getFiveEPlayMatch(
  input: string,
  options: GetFiveEPlayMatchOptions = {},
): Promise<GetFiveEPlayMatchResult> {
  return (await captureFiveEPlayMatch(input, options, options)).result;
}
