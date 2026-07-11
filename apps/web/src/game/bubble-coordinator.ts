import { gameEvents, type GameEventBus } from './events';

export interface BubbleCoordinatorOptions {
  durationMs?: (text: string) => number;
}

interface ActiveBubble {
  ownerId: string;
  kind: 'speech' | 'thought';
}

export class BubbleCoordinator {
  private active: ActiveBubble | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly durationMs: (text: string) => number;

  constructor(private readonly events: GameEventBus, options: BubbleCoordinatorOptions = {}) {
    this.durationMs = options.durationMs ?? defaultDurationMs;
  }

  showDecision(ownerId: string, speech: string, thought?: string): void {
    this.replace(ownerId, 'speech', speech);
    this.timer = setTimeout(() => {
      if (!this.owns(ownerId, 'speech')) return;
      if (thought) {
        this.replace(ownerId, 'thought', thought);
        this.timer = setTimeout(() => this.clearOwner(ownerId), this.durationMs(thought));
      } else {
        this.clearOwner(ownerId);
      }
    }, this.durationMs(speech));
  }

  showAction(ownerId: string, text: string): void {
    this.replace(ownerId, 'speech', text);
  }

  clearOwner(ownerId: string): boolean {
    if (!this.active || this.active.ownerId !== ownerId) return false;
    this.clearTimer();
    this.events.emit('bubble-changed', { kind: this.active.kind, ownerId });
    this.active = undefined;
    return true;
  }

  reset(): void {
    this.clearTimer();
    if (!this.active) return;
    this.events.emit('bubble-changed', {
      kind: this.active.kind,
      ownerId: this.active.ownerId,
    });
    this.active = undefined;
  }

  private replace(ownerId: string, kind: ActiveBubble['kind'], text: string): void {
    this.clearTimer();
    if (this.active) {
      this.events.emit('bubble-changed', {
        kind: this.active.kind,
        ownerId: this.active.ownerId,
      });
    }
    this.active = { ownerId, kind };
    this.events.emit('bubble-changed', { kind, text, ownerId });
  }

  private owns(ownerId: string, kind: ActiveBubble['kind']): boolean {
    return this.active?.ownerId === ownerId && this.active.kind === kind;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function defaultDurationMs(text: string): number {
  return Math.min(5_000, Math.max(1_800, 1_000 + [...text].length * 18));
}

export const gameBubbles = new BubbleCoordinator(gameEvents);
