import { FiveEPlaySourceError } from '../domain/errors.js';
import type { MatchUpdate } from '../domain/model.js';

interface Waiter {
  readonly resolve: (result: IteratorResult<MatchUpdate>) => void;
  readonly reject: (error: unknown) => void;
}

export class WatchQueue {
  readonly #maximumSize: number;
  readonly #onOverflow: ((error: FiveEPlaySourceError) => void) | undefined;
  readonly #items: MatchUpdate[] = [];
  readonly #waiters: Waiter[] = [];
  #closed = false;
  #error: unknown = null;

  constructor(
    maximumSize = 256,
    onOverflow?: (error: FiveEPlaySourceError) => void,
  ) {
    this.#maximumSize = maximumSize;
    this.#onOverflow = onOverflow;
  }

  push(update: MatchUpdate): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: update });
      return;
    }

    if (update.kind === 'provisional-telemetry') {
      const last = this.#items.at(-1);
      if (last?.kind === 'provisional-telemetry') {
        this.#items[this.#items.length - 1] = update;
        return;
      }
    } else {
      const last = this.#items.at(-1);
      if (
        update.kind === 'blocked' &&
        last?.kind === 'blocked' &&
        update.reason === last.reason &&
        update.lastConfirmed?.revision === last.lastConfirmed?.revision
      ) {
        this.#items[this.#items.length - 1] = update;
        return;
      }
    }

    if (this.#items.length >= this.#maximumSize) {
      const error = new FiveEPlaySourceError(
        'PROVIDER_FAILURE',
        'watch consumer fell behind the bounded update queue',
      );
      this.close(error);
      this.#onOverflow?.(error);
      return;
    }
    this.#items.push(update);
  }

  next(): Promise<IteratorResult<MatchUpdate>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.#closed) {
      return this.#error === null
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.#error);
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ reject, resolve });
    });
  }

  close(error: unknown = null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    if (this.#items.length > 0) return;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === null) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }
}
