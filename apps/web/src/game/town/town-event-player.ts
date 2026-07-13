import { TownEventSchema, TownProjectionSchema, type Position, type TownEvent, type TownProjection } from '@cat-house/shared';

import { gameEvents } from '../events';

export interface TownScenePort {
  applySnapshot(snapshot: TownProjection): void;
  moveResident(residentId: string, position: Position, signal: AbortSignal): Promise<void>;
  speak(residentId: string, text: string, signal: AbortSignal): Promise<void>;
  playActivity(event: TownEvent, signal: AbortSignal): Promise<void>;
  applyModification(event: TownEvent, signal: AbortSignal): Promise<void>;
  followResident(residentId: string): void;
}

type PlayerHooks = { onFailure?: (event: TownEvent, error: Error) => void };

export class TownEventPlayer {
  readonly #played = new Set<string>();
  #controller: AbortController | undefined;

  constructor(private readonly scene: TownScenePort, private readonly hooks: PlayerHooks = {}) {}

  async play(events: readonly TownEvent[], finalProjection: TownProjection, signal?: AbortSignal): Promise<void> {
    this.cancel();
    const projection = TownProjectionSchema.parse(finalProjection);
    const controller = new AbortController();
    this.#controller = controller;
    const removeExternalAbort = linkAbort(signal, controller);
    try {
      const parsed = events.map((event) => TownEventSchema.parse(event)).sort((a, b) => a.sequence - b.sequence);
      for (const event of parsed) {
        if (this.#played.has(event.id)) continue;
        await abortable(this.#playEvent(event, controller.signal), controller.signal);
        this.#played.add(event.id);
      }
    } catch (cause) {
      const error = isErrorLike(cause) ? cause : new Error(String(cause));
      if (error.name !== 'AbortError') {
        const failed = events.find((event) => !this.#played.has(event.id));
        if (failed) this.hooks.onFailure?.(failed, error);
        this.scene.applySnapshot(projection);
      }
      throw error;
    } finally {
      removeExternalAbort();
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  cancel(): void {
    this.#controller?.abort();
    this.#controller = undefined;
  }

  async #playEvent(event: TownEvent, signal: AbortSignal): Promise<void> {
    if (event.type === 'resident.moved') return this.scene.moveResident(event.payload.residentId, event.payload.position, signal);
    if (event.type === 'resident.spoke') return this.scene.speak(event.payload.residentId, event.payload.text, signal);
    if (event.type === 'build.completed') return this.scene.applyModification(event, signal);
    if (HIGH_PRIORITY_EVENTS.has(event.type)) gameEvents.emit('town-subtitle', { eventId: event.id, text: subtitleFor(event) });
    return this.scene.playActivity(event, signal);
  }
}

function isErrorLike(value: unknown): value is Error {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string' && typeof Reflect.get(value, 'message') === 'string';
}

const HIGH_PRIORITY_EVENTS = new Set<TownEvent['type']>(['fortune.revealed', 'fortune.interpreted', 'build.completed', 'outing.returned']);

function subtitleFor(event: TownEvent): string {
  if (event.type === 'fortune.interpreted') return event.payload.interpretation;
  if (event.type === 'fortune.revealed') return `抽到了 ${event.payload.rank} 签`;
  if (event.type === 'build.completed') return '小镇里出现了新的改造';
  return '桌宠带着一段新经历回家了';
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Playback cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Playback cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
