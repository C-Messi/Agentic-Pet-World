import type {
  TownEvent,
  TownProjection,
  TownPulseRequest,
  TownPulseResponse,
} from '@cat-house/shared';

type PulseApi = {
  pulse(
    request: TownPulseRequest,
    signal: AbortSignal,
  ): Promise<TownPulseResponse>;
};

type Playback = {
  playAndConfirm(
    sessionId: string,
    events: readonly TownEvent[],
    projection: TownProjection,
    signal?: AbortSignal,
  ): Promise<void>;
};

export class TownPulseLoop {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #getProjection: (() => TownProjection) | undefined;
  #running = false;
  #counter = 0;

  constructor(
    private readonly api: PulseApi,
    private readonly playback: Playback,
    private readonly publish: (projection: TownProjection) => void,
  ) {}

  start(getProjection: () => TownProjection): void {
    if (this.#running) return;
    this.#running = true;
    this.#getProjection = getProjection;
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    this.#getProjection = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  #schedule(): void {
    if (!this.#running || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#pulse();
    }, 4_000);
  }

  async #pulse(): Promise<void> {
    if (!this.#running || !this.#getProjection || this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const current = this.#getProjection();
      const response = await this.api.pulse(
        {
          sessionId: current.sessionId,
          baseVersion: current.version,
          pulseId: `pulse-${++this.#counter}-${crypto.randomUUID()}`,
        },
        controller.signal,
      );
      if (!this.#isCurrent(controller)) return;
      if (response.status === 'advanced') {
        await this.playback.playAndConfirm(
          response.projection.sessionId,
          response.events,
          response.projection,
          controller.signal,
        );
      }
      if (this.#isCurrent(controller)) this.publish(response.projection);
    } catch {
      // A later pulse retries ordinary failures; stop invalidates this controller.
    } finally {
      if (this.#controller === controller) {
        this.#controller = undefined;
        this.#schedule();
      }
    }
  }

  #isCurrent(controller: AbortController): boolean {
    return (
      this.#running &&
      this.#controller === controller &&
      !controller.signal.aborted
    );
  }
}
