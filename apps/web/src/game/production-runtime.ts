import type { MemoryRecord, MessageRecord, SessionResponse } from '@cat-house/shared';

import type { GameUiRuntime, RuntimeSnapshot } from '../App';
import { ActionRunner } from './actions/action-runner';
import { WorldSceneActionAdapter } from './actions/world-scene-action-adapter';
import { AgentApiClient, AgentBridge, AgentHttpError } from './agent/agent-bridge';
import { createGame } from './create-game';
import { gameEvents } from './events';
import { WorldScene } from './scenes/world-scene';

export function createProductionRuntime(parent: HTMLElement): GameUiRuntime {
  return new ProductionGameRuntime(parent, import.meta.env.VITE_API_URL ?? '');
}

class ProductionGameRuntime implements GameUiRuntime {
  readonly events = gameEvents;
  private readonly game: ReturnType<typeof createGame>;
  private readonly api: AgentApiClient;
  private readonly bridge: AgentBridge;
  private readonly worldReady: Promise<void>;
  private removeWorldReadyListener: (() => void) | undefined;
  private sessionId: string | undefined;

  constructor(parent: HTMLElement, readonly apiUrl: string) {
    this.worldReady = new Promise((resolve) => {
      this.removeWorldReadyListener = this.events.on('world-ready', () => {
        this.removeWorldReadyListener?.();
        this.removeWorldReadyListener = undefined;
        resolve();
      });
    });
    this.game = createGame(parent);
    const scene = this.game.scene.getScene(WorldScene.key) as WorldScene;
    const adapter = new WorldSceneActionAdapter(scene);
    const runner = new ActionRunner(adapter, this.events);
    this.api = new AgentApiClient({ baseUrl: apiUrl });
    this.bridge = new AgentBridge(this.api, runner, this.events, () => adapter.getSnapshot());
  }

  async initialize(storedSessionId?: string): Promise<RuntimeSnapshot> {
    try {
      const session = storedSessionId
        ? await this.loadOrReplaceMissingSession(storedSessionId)
        : await this.createSessionSnapshot();
      this.sessionId = session.session.id;
      await this.worldReady;
      return { sessionId: session.session.id, messages: session.messages };
    } catch (error) {
      this.events.emit('connection-status', {
        status: error instanceof AgentHttpError ? 'provider-error' : 'offline',
        message: error instanceof Error ? error.message : 'Unable to connect',
      });
      throw error;
    }
  }

  async sendMessage(message: string): Promise<{ accepted: boolean }> {
    const outcome = await this.bridge.sendPlayerMessage(message);
    return { accepted: outcome.source === 'server' };
  }

  cancel(): void {
    this.bridge.cancel();
  }

  async loadConversation(): Promise<readonly MessageRecord[]> {
    if (!this.sessionId) return [];
    return (await this.api.loadSession(this.sessionId)).messages;
  }

  async loadMemories(): Promise<readonly MemoryRecord[]> {
    if (!this.sessionId) return [];
    return this.api.listMemories(this.sessionId);
  }

  setMuted(muted: boolean): void {
    this.game.sound.mute = muted;
  }

  destroy(): void {
    this.removeWorldReadyListener?.();
    this.removeWorldReadyListener = undefined;
    this.bridge.cancel();
    this.game.destroy(true);
  }

  private async loadOrReplaceMissingSession(sessionId: string): Promise<SessionResponse> {
    try {
      return await this.bridge.loadSession(sessionId);
    } catch (error) {
      if (!(error instanceof AgentHttpError) || error.status !== 404) throw error;
      return this.createSessionSnapshot();
    }
  }

  private async createSessionSnapshot(): Promise<SessionResponse> {
    const created = await this.bridge.createSession();
    return { session: created.session, world: null, messages: [] };
  }
}
