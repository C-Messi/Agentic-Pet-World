import type {
  MemoryRecord,
  MessageRecord,
  PublicShowcaseItem,
  SessionResponse,
  TownAdvanceRequest,
  TownEvent,
  TownProjection,
  TownSnapshotResponse,
  WorldSnapshot,
} from '@cat-house/shared';

import type { GameUiRuntime, RuntimeSnapshot } from '../App';
import { ActionRunner } from './actions/action-runner';
import { WorldSceneActionAdapter } from './actions/world-scene-action-adapter';
import {
  AgentApiClient,
  AgentBridge,
  AgentHttpError,
} from './agent/agent-bridge';
import { gameBubbles } from './bubble-coordinator';
import { createGame } from './create-game';
import { gameEvents } from './events';
import { WorldScene } from './scenes/world-scene';
import { TownScene } from './scenes/town-scene';
import { TownApiClient } from './town/town-api-client';
import { TownEventPlayer } from './town/town-event-player';
import { TownPlaybackCoordinator } from './town/town-playback-coordinator';

export function createProductionRuntime(parent: HTMLElement): GameUiRuntime {
  return new ProductionGameRuntime(parent, import.meta.env.VITE_API_URL ?? '');
}

class ProductionGameRuntime implements GameUiRuntime {
  readonly events = gameEvents;
  private readonly game: ReturnType<typeof createGame>;
  private readonly api: AgentApiClient;
  private readonly bridge: AgentBridge;
  private readonly townApi: TownApiClient;
  private readonly worldReady: Promise<void>;
  private removeWorldReadyListener: (() => void) | undefined;
  private removeWorldSnapshotListener: (() => void) | undefined;
  private sessionId: string | undefined;
  private latestSnapshot: WorldSnapshot | undefined;
  private townSnapshot: TownSnapshotResponse | undefined;
  private pendingRecoveryEvents: readonly TownEvent[] = [];

  constructor(
    parent: HTMLElement,
    readonly apiUrl: string,
  ) {
    this.worldReady = new Promise((resolve) => {
      this.removeWorldReadyListener = this.events.on(
        'world-ready',
        (snapshot) => {
          this.latestSnapshot = snapshot;
          this.removeWorldReadyListener?.();
          this.removeWorldReadyListener = undefined;
          resolve();
        },
      );
    });
    this.removeWorldSnapshotListener = this.events.on(
      'world-snapshot',
      (snapshot) => {
        this.latestSnapshot = snapshot;
      },
    );
    this.game = createGame(parent);
    const adapter = new WorldSceneActionAdapter(
      () => this.game.scene.getScene(WorldScene.key) as WorldScene,
    );
    const runner = new ActionRunner(adapter, this.events);
    this.api = new AgentApiClient({ baseUrl: apiUrl });
    this.townApi = new TownApiClient({ baseUrl: apiUrl });
    this.bridge = new AgentBridge(
      this.api,
      runner,
      this.events,
      () => this.requireLatestSnapshot(),
      { bubbles: gameBubbles },
    );
  }

  async initialize(storedSessionId?: string): Promise<RuntimeSnapshot> {
    try {
      const session = storedSessionId
        ? await this.loadOrReplaceMissingSession(storedSessionId)
        : await this.createSessionSnapshot();
      this.sessionId = session.session.id;
      this.townSnapshot = await this.townApi.snapshot(session.session.id);
      await this.worldReady;
      await this.recoverActiveOuting();
      const playerId = this.playerResidentId();
      if (
        this.townSnapshot.outings.some(
          (outing) =>
            outing.residentId === playerId && outing.status !== 'home',
        )
      ) {
        const ready = this.waitForTownReady();
        this.game.scene.stop(WorldScene.key);
        this.game.scene.start(TownScene.key, {
          snapshot: this.townSnapshot.projection,
        });
        await ready;
        await this.playTownEvents(
          this.pendingRecoveryEvents,
          this.townSnapshot.projection,
        );
        this.pendingRecoveryEvents = [];
      }
      return {
        sessionId: session.session.id,
        messages: session.messages,
        town: this.townSnapshot,
      };
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

  async releasePet(): Promise<TownSnapshotResponse> {
    const sessionId = this.requireSessionId();
    const residentId = this.playerResidentId();
    const previousSequence =
      this.townSnapshot?.projection.lastEventSequence ?? 0;
    const response = await this.townApi.release(sessionId, residentId);
    this.townSnapshot = {
      ...(this.townSnapshot ?? (await this.townApi.snapshot(sessionId))),
      projection: response.projection,
      outings: [response.outing],
    };
    const ready = this.waitForTownReady();
    this.game.scene.stop(WorldScene.key);
    this.game.scene.start(TownScene.key, { snapshot: response.projection });
    await ready;
    await this.playEventsSince(previousSequence, response.projection);
    return this.townSnapshot;
  }

  async recallPet(): Promise<TownSnapshotResponse> {
    const sessionId = this.requireSessionId();
    const previousCardIds = new Set(
      this.townSnapshot?.experienceCards.map(({ id }) => id) ?? [],
    );
    const previousSequence =
      this.townSnapshot?.projection.lastEventSequence ?? 0;
    const response = await this.townApi.recall(
      sessionId,
      this.playerResidentId(),
    );
    await this.playEventsSince(previousSequence, response.projection);
    this.game.scene.stop(TownScene.key);
    this.game.scene.start(WorldScene.key);
    this.townSnapshot = await this.townApi.snapshot(sessionId);
    const newCard = this.townSnapshot.experienceCards.find(
      ({ id }) => !previousCardIds.has(id),
    );
    const latestCard = newCard ?? this.townSnapshot.experienceCards.at(-1);
    const text = latestCard?.body ?? 'I came home after a quiet outing.';
    this.events.emit('town-return-speech', { text });
    gameBubbles.showDecision(this.playerResidentId(), text);
    if (newCard)
      this.events.emit('town-experience-card-created', { cardId: newCard.id });
    return this.townSnapshot;
  }

  followTownResident(residentId: string): void {
    if (!this.game.scene.isActive(TownScene.key)) return;
    (this.game.scene.getScene(TownScene.key) as TownScene).followResident(
      residentId,
    );
  }

  async advanceTown(
    request: Omit<TownAdvanceRequest, 'sessionId'>,
  ): Promise<TownProjection> {
    const response = await this.townApi.advance({
      ...request,
      sessionId: this.requireSessionId(),
    });
    await this.playTownEvents(response.events, response.projection);
    if (this.townSnapshot)
      this.townSnapshot = {
        ...this.townSnapshot,
        projection: response.projection,
      };
    return response.projection;
  }

  async loadTownHistory() {
    const response = await this.townApi.history(this.requireSessionId());
    return {
      events: response.events,
      experienceCards: response.experienceCards,
    };
  }
  async loadTownRelationships() {
    return (await this.townApi.relationships(this.requireSessionId()))
      .relationships;
  }
  async loadExperienceCards() {
    return (await this.townApi.experienceCards(this.requireSessionId()))
      .experienceCards;
  }
  async loadShowcase() {
    return (await this.townApi.listShowcase(this.requireSessionId())).items;
  }
  async saveShowcase(item: PublicShowcaseItem) {
    await this.townApi.upsertShowcase(this.requireSessionId(), item);
    return this.loadShowcase();
  }
  async deleteShowcase(itemId: string) {
    await this.townApi.deleteShowcase(this.requireSessionId(), itemId);
    return this.loadShowcase();
  }

  setMuted(muted: boolean): void {
    this.game.sound.mute = muted;
  }

  destroy(): void {
    this.removeWorldReadyListener?.();
    this.removeWorldReadyListener = undefined;
    this.removeWorldSnapshotListener?.();
    this.removeWorldSnapshotListener = undefined;
    this.bridge.cancel();
    this.game.destroy(true);
  }

  private async loadOrReplaceMissingSession(
    sessionId: string,
  ): Promise<SessionResponse> {
    try {
      return await this.bridge.loadSession(sessionId);
    } catch (error) {
      if (!(error instanceof AgentHttpError) || error.status !== 404)
        throw error;
      return this.createSessionSnapshot();
    }
  }

  private async createSessionSnapshot(): Promise<SessionResponse> {
    const created = await this.bridge.createSession();
    return { session: created.session, world: null, messages: [] };
  }

  private requireLatestSnapshot(): WorldSnapshot {
    if (!this.latestSnapshot) throw new Error('World snapshot is unavailable');
    return this.latestSnapshot;
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error('Session is unavailable');
    return this.sessionId;
  }

  private playerResidentId(): string {
    const resident = this.townSnapshot?.projection.residents.find(
      ({ pet }) => pet.source === 'player-pet',
    );
    if (!resident) throw new Error('Player pet is unavailable');
    return resident.residentId;
  }

  private async recoverActiveOuting(): Promise<void> {
    const snapshot = this.townSnapshot;
    if (!snapshot) return;
    const player = snapshot.projection.residents.find(
      ({ pet }) => pet.source === 'player-pet',
    );
    const outing = snapshot.outings.find(
      (item) =>
        item.residentId === player?.residentId && item.status !== 'home',
    );
    if (!outing?.lastConfirmedAt) return;
    const key = `agent-cat-house.town-recovery.${snapshot.projection.sessionId}.${outing.residentId}`;
    const recoveryWindowId =
      safeStorageGet(key) ?? `recovery-${crypto.randomUUID()}`;
    safeStorageSet(key, recoveryWindowId);
    const result = await this.townApi.recover({
      sessionId: snapshot.projection.sessionId,
      residentId: outing.residentId,
      lastConfirmedAt: outing.lastConfirmedAt,
      recoveryWindowId,
    });
    this.townSnapshot = {
      ...snapshot,
      projection: result.projection,
      outings: snapshot.outings.map((item) =>
        item.residentId === result.outing.residentId ? result.outing : item,
      ),
      experienceCards: [...snapshot.experienceCards, ...result.experienceCards],
    };
    this.pendingRecoveryEvents = result.events;
    safeStorageRemove(key);
    const latest = result.events.at(-1);
    if (latest)
      this.events.emit('town-subtitle', {
        eventId: latest.id,
        text: '桌宠在小镇里又有了新经历',
      });
  }

  private async playEventsSince(
    sequence: number,
    projection: TownProjection,
  ): Promise<void> {
    const history = await this.townApi.history(this.requireSessionId());
    await this.playTownEvents(
      history.events.filter((event) => event.sequence > sequence),
      projection,
    );
  }

  private async playTownEvents(
    events: readonly TownEvent[],
    projection: TownProjection,
  ): Promise<void> {
    if (events.length === 0) return;
    const scene = this.game.scene.getScene(TownScene.key) as TownScene;
    const coordinator = new TownPlaybackCoordinator(
      new TownEventPlayer(scene),
      this.townApi,
    );
    await coordinator.playAndConfirm(
      this.requireSessionId(),
      events,
      projection,
    );
  }

  private waitForTownReady(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.events.on('town-ready', () => {
        off();
        resolve();
      });
    });
  }
}

function safeStorageGet(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* keep the active recovery in memory */
  }
}
function safeStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* a repeated idempotent recovery remains safe */
  }
}
