import { createHash } from 'node:crypto';

import type { ConfirmedRevision, UnixMilliseconds } from '../domain/model.js';

export function unixMilliseconds(value = Date.now()): UnixMilliseconds {
  return value as UnixMilliseconds;
}

export function confirmedRevision(value: unknown): ConfirmedRevision {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex') as ConfirmedRevision;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function integer(value: unknown, label: string): number {
  const number = nullableNumber(value);
  if (number === null || !Number.isInteger(number)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return number;
}

export function secondsToMilliseconds(value: unknown): UnixMilliseconds | null {
  const seconds = nullableNumber(value);
  return seconds === null ? null : unixMilliseconds(seconds * 1_000);
}
