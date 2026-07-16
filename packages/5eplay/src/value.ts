import type { FiveEPlayJson, FiveEPlayJsonObject } from './types.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function sourceText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[%+,]/g, '');
  if (!normalized || normalized === '--' || normalized === '-') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function integer(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed === null || !Number.isInteger(parsed) ? null : parsed;
}

export function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0' || value === 2 || value === '2') return false;
  return null;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' ? [item] : [])
    : [];
}

export function json(value: unknown): FiveEPlayJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, json(nested)]),
    );
  }
  return null;
}

export function jsonObject(value: unknown): FiveEPlayJsonObject {
  const converted = json(value);
  return converted !== null && typeof converted === 'object' && !Array.isArray(converted)
    ? converted
    : {};
}

export function jsonObjects(value: unknown): FiveEPlayJsonObject[] {
  return Array.isArray(value) ? value.map(jsonObject) : [];
}

export function side(value: unknown): 'CT' | 'T' | null {
  const normalized = text(value)?.toUpperCase();
  if (normalized === 'CT') return 'CT';
  if (normalized === 'T' || normalized === 'TERRORIST') return 'T';
  return null;
}
