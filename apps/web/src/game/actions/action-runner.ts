import {
  AgentDecisionSchema,
  type ActionResult,
  type AgentAction,
  type AgentDecision,
  type Emotion,
  type Interaction,
  type WorldObjectId,
  type WorldSnapshot,
} from '@cat-house/shared';

import type { GameEventBus } from '../events';

export interface ActionWorldPort {
  hasTarget(targetId: WorldObjectId): boolean;
  setAmbientSuspended(suspended: boolean): void;
  moveTo(targetId: WorldObjectId, signal: AbortSignal): Promise<void>;
  interact(targetId: WorldObjectId, interaction: Interaction, signal: AbortSignal): Promise<void>;
  emote(emotion: Emotion, durationMs: number, signal: AbortSignal): Promise<void>;
  wait(durationMs: number, signal: AbortSignal): Promise<void>;
  speak(text: string, signal: AbortSignal): Promise<void>;
  getSnapshot(): WorldSnapshot;
}

export interface CorrelatedActionResult {
  turnCorrelationId: string;
  result: ActionResult;
}

export interface ActionRunOptions {
  signal?: AbortSignal;
  onResult?: (result: CorrelatedActionResult, snapshot: WorldSnapshot) => void | Promise<void>;
}

export interface ActionRunnerOptions {
  defaultTimeoutMs?: number;
  failureEmoteDurationMs?: number;
  failureEmoteTimeoutMs?: number;
  now?: () => Date;
}

export class ActionExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActionExecutionError';
  }
}

class ActionTimeoutError extends Error {}

export class ActionRunner {
  private readonly defaultTimeoutMs: number;
  private readonly failureEmoteDurationMs: number;
  private readonly failureEmoteTimeoutMs: number;
  private readonly now: () => Date;
  private activeController: AbortController | undefined;
  private activeAction: AgentAction | undefined;

  constructor(
    private readonly world: ActionWorldPort,
    private readonly events: GameEventBus,
    options: ActionRunnerOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.failureEmoteDurationMs = options.failureEmoteDurationMs ?? 1_200;
    this.failureEmoteTimeoutMs = options.failureEmoteTimeoutMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  get currentAction(): AgentAction | undefined {
    return this.activeAction;
  }

  cancel(): void {
    this.activeController?.abort();
  }

  async run(
    input: AgentDecision,
    turnCorrelationId: string,
    options: ActionRunOptions = {},
  ): Promise<CorrelatedActionResult[]> {
    const decision = AgentDecisionSchema.parse(input);
    this.cancel();
    const controller = new AbortController();
    this.activeController = controller;
    const unlink = linkAbortSignal(options.signal, controller);
    const results: CorrelatedActionResult[] = [];
    this.world.setAmbientSuspended(true);
    this.events.emit('agent-busy', { busy: true });

    try {
      for (const [index, action] of decision.actions.entries()) {
        if (controller.signal.aborted) {
          await this.cancelRemaining(
            decision.actions.slice(index),
            turnCorrelationId,
            results,
            options,
            'ACTION_CANCELLED',
            'Action sequence cancelled',
          );
          break;
        }
        this.activeAction = action;
        this.events.emit('action-started', { turnCorrelationId, action });
        const result = await this.execute(action, controller.signal);
        const correlated = { turnCorrelationId, result };
        await this.publishResult(correlated, results, options);
        if (result.status !== 'succeeded') {
          const remaining = decision.actions.slice(index + 1);
          await this.cancelRemaining(
            remaining,
            turnCorrelationId,
            results,
            options,
            result.status === 'cancelled' ? 'ACTION_CANCELLED' : 'QUEUE_STOPPED',
            result.status === 'cancelled'
              ? 'Action sequence cancelled'
              : `Skipped because action ${action.id} ${result.status}`,
          );
          if (result.status !== 'cancelled') {
            await this.showFailureEmote(controller, controller.signal);
          }
          break;
        }
      }
      return results;
    } finally {
      unlink();
      if (this.activeController === controller) {
        this.activeAction = undefined;
        this.activeController = undefined;
        this.world.setAmbientSuspended(false);
        this.events.emit('agent-busy', { busy: false });
      }
    }
  }

  private async execute(action: AgentAction, parentSignal: AbortSignal): Promise<ActionResult> {
    if ('targetId' in action && !this.world.hasTarget(action.targetId)) {
      return this.result(action, 'failed', 'Unknown or unavailable target', 'UNKNOWN_TARGET');
    }

    const actionController = new AbortController();
    const unlink = linkAbortSignal(parentSignal, actionController);
    const cancellation = abortRace(parentSignal);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const operation = this.executeWithAdapter(action, actionController.signal);
      const timeoutMs = action.type === 'move_to' ? action.timeoutMs : this.defaultTimeoutMs;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new ActionTimeoutError(`Action timed out after ${timeoutMs}ms`));
          actionController.abort();
        }, timeoutMs);
      });
      await Promise.race([operation, timeout, cancellation.promise]);
      return this.result(action, 'succeeded');
    } catch (error) {
      if (timedOut || error instanceof ActionTimeoutError) {
        const message =
          error instanceof ActionTimeoutError ? error.message : 'Action timed out';
        return this.result(action, 'timed_out', message, 'ACTION_TIMEOUT');
      }
      if (parentSignal.aborted || isAbortError(error)) {
        return this.result(action, 'cancelled', 'Action cancelled', 'ACTION_CANCELLED');
      }
      if (error instanceof ActionExecutionError) {
        return this.result(action, 'failed', error.message, error.code);
      }
      return this.result(action, 'failed', errorMessage(error), 'ACTION_FAILED');
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      cancellation.cleanup();
      unlink();
    }
  }

  private executeWithAdapter(action: AgentAction, signal: AbortSignal): Promise<void> {
    switch (action.type) {
      case 'move_to':
        return this.world.moveTo(action.targetId, signal);
      case 'interact':
        return this.world.interact(action.targetId, action.interaction, signal);
      case 'emote':
        return this.world.emote(action.emotion, action.durationMs, signal);
      case 'wait':
        return this.world.wait(action.durationMs, signal);
      case 'speak':
        return this.world.speak(action.text, signal);
    }
  }

  private result(
    action: AgentAction,
    status: ActionResult['status'],
    message?: string,
    errorCode?: string,
  ): ActionResult {
    return {
      actionId: action.id,
      type: action.type,
      status,
      ...(message === undefined ? {} : { message }),
      ...(errorCode === undefined ? {} : { errorCode }),
      completedAt: this.now().toISOString(),
    };
  }

  private async publishResult(
    correlated: CorrelatedActionResult,
    results: CorrelatedActionResult[],
    options: ActionRunOptions,
  ): Promise<void> {
    results.push(correlated);
    this.events.emit(
      correlated.result.status === 'succeeded' ? 'action-completed' : 'action-failed',
      correlated,
    );
    await options.onResult?.(correlated, this.world.getSnapshot());
  }

  private async cancelRemaining(
    actions: readonly AgentAction[],
    turnCorrelationId: string,
    results: CorrelatedActionResult[],
    options: ActionRunOptions,
    errorCode: 'ACTION_CANCELLED' | 'QUEUE_STOPPED',
    message: string,
  ): Promise<void> {
    for (const action of actions) {
      await this.publishResult(
        {
          turnCorrelationId,
          result: this.result(action, 'cancelled', message, errorCode),
        },
        results,
        options,
      );
    }
  }

  private async showFailureEmote(
    owner: AbortController,
    ownerSignal: AbortSignal,
  ): Promise<void> {
    if (this.activeController !== owner || ownerSignal.aborted) return;
    const feedbackController = new AbortController();
    const unlink = linkAbortSignal(ownerSignal, feedbackController);
    const cancellation = abortRace(ownerSignal);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        feedbackController.abort();
        reject(new ActionTimeoutError('Failure feedback timed out'));
      }, this.failureEmoteTimeoutMs);
    });
    try {
      await Promise.race([
        this.world.emote('confused', this.failureEmoteDurationMs, feedbackController.signal),
        cancellation.promise,
        timeout,
      ]);
    } catch {
      // The original action result remains authoritative if recovery feedback also fails.
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      cancellation.cleanup();
      unlink();
    }
  }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function abortRace(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let abort: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
  });
  return { promise, cleanup: () => signal.removeEventListener('abort', abort) };
}

function abortError(): Error {
  return new DOMException('Action cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Action failed';
}
