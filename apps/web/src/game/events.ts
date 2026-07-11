import type { AgentAction, ActionResult, WorldSnapshot } from '@cat-house/shared';

export type ConnectionStatus =
  | 'connecting'
  | 'ready'
  | 'thinking'
  | 'acting'
  | 'offline'
  | 'cancelled'
  | 'provider-error';

export interface CorrelatedResultPayload {
  turnCorrelationId: string;
  result: ActionResult;
}

export interface GameEventMap {
  'world-ready': WorldSnapshot;
  'world-snapshot': WorldSnapshot;
  'agent-busy': { busy: boolean };
  'bubble-changed': { kind: 'speech' | 'thought'; text?: string; ownerId?: string };
  'action-started': { turnCorrelationId: string; action: AgentAction };
  'action-completed': CorrelatedResultPayload;
  'action-failed': CorrelatedResultPayload;
  'connection-status': { status: ConnectionStatus; message?: string };
}

type EventListener<T> = (payload: T) => void;

export class GameEventBus {
  private readonly listeners = new Map<keyof GameEventMap, Set<EventListener<unknown>>>();

  on<K extends keyof GameEventMap>(event: K, listener: EventListener<GameEventMap[K]>): () => void {
    const listeners = this.listeners.get(event) ?? new Set<EventListener<unknown>>();
    listeners.add(listener as EventListener<unknown>);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  off<K extends keyof GameEventMap>(event: K, listener: EventListener<GameEventMap[K]>): void {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener as EventListener<unknown>);
    if (listeners?.size === 0) this.listeners.delete(event);
  }

  emit<K extends keyof GameEventMap>(event: K, payload: GameEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const gameEvents = new GameEventBus();
