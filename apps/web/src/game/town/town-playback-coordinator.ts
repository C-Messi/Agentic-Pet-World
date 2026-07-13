import type {
  TownEvent,
  TownEventResultsRequest,
  TownProjection,
} from '@cat-house/shared';

type Player = {
  play(
    events: readonly TownEvent[],
    projection: TownProjection,
    signal?: AbortSignal,
  ): Promise<void>;
};
type ResultApi = {
  deliverEventResults(request: TownEventResultsRequest): Promise<unknown>;
};

export class TownPlaybackCoordinator {
  constructor(
    private readonly player: Player,
    private readonly api: ResultApi,
  ) {}

  async playAndConfirm(
    sessionId: string,
    events: readonly TownEvent[],
    projection: TownProjection,
    signal?: AbortSignal,
  ): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.player.play(events, projection, signal);
      await this.api.deliverEventResults({
        sessionId,
        baseVersion: projection.version,
        results: events.map(({ id }) => ({
          eventId: id,
          status: 'applied' as const,
        })),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message =
        error instanceof Error ? error.message : 'Town event playback failed';
      await this.api.deliverEventResults({
        sessionId,
        baseVersion: projection.version,
        results: events.map(({ id }) => ({
          eventId: id,
          status: 'failed' as const,
          message,
        })),
      });
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'name') === 'AbortError'
  );
}
