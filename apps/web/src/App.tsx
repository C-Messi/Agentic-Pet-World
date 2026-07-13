import type { ExperienceCard, MemoryRecord, MessageRecord, PublicShowcaseItem, TownEvent, TownProjection, TownRelationship, TownSnapshotResponse } from '@cat-house/shared';
import { BookOpen, Brain, Heart, Images, MessageCircle, RefreshCw, Settings, Store, Volume2, VolumeX } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { ConnectionStatus, GameEventBus } from './game/events';
import { CommandDock } from './ui/command-dock';
import { ConversationPanel } from './ui/conversation-panel';
import { Drawer } from './ui/drawer';
import { MemoryPanel } from './ui/memory-panel';
import { SettingsPanel } from './ui/settings-panel';
import { StatusBar } from './ui/status-bar';
import { ExperiencePanel } from './ui/experience-panel';
import { RelationshipsPanel } from './ui/relationships-panel';
import { ShowcasePanel } from './ui/showcase-panel';
import { TownControls } from './ui/town-controls';
import { TownHistoryPanel } from './ui/town-history-panel';

export const SESSION_STORAGE_KEY = 'agent-cat-house.session-id';

export interface RuntimeSnapshot {
  sessionId: string;
  messages: readonly MessageRecord[];
  town?: TownSnapshotResponse;
}

export interface GameUiRuntime {
  readonly events: GameEventBus;
  readonly apiUrl: string;
  initialize(storedSessionId?: string): Promise<RuntimeSnapshot>;
  sendMessage(message: string): Promise<{ accepted: boolean }>;
  cancel(): void;
  loadConversation(): Promise<readonly MessageRecord[]>;
  loadMemories(): Promise<readonly MemoryRecord[]>;
  releasePet?(): Promise<TownSnapshotResponse>;
  recallPet?(): Promise<TownSnapshotResponse>;
  followTownResident?(residentId: string): void;
  loadTownHistory?(): Promise<{ events: readonly TownEvent[]; experienceCards: readonly ExperienceCard[] }>;
  loadTownRelationships?(): Promise<readonly TownRelationship[]>;
  loadExperienceCards?(): Promise<readonly ExperienceCard[]>;
  loadShowcase?(): Promise<readonly PublicShowcaseItem[]>;
  saveShowcase?(item: PublicShowcaseItem): Promise<readonly PublicShowcaseItem[]>;
  deleteShowcase?(itemId: string): Promise<readonly PublicShowcaseItem[]>;
  setMuted(muted: boolean): void;
  destroy(): void;
}

export type RuntimeFactory = (gameParent: HTMLElement) => GameUiRuntime;
type DrawerName = 'conversation' | 'memory' | 'settings' | 'town-history' | 'relationships' | 'experiences' | 'showcase';
type DataDrawerName = Exclude<DrawerName, 'settings'>;

export function App({ runtimeFactory }: { runtimeFactory: RuntimeFactory }) {
  const gameParentRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<GameUiRuntime | undefined>(undefined);
  const conversationButtonRef = useRef<HTMLButtonElement>(null);
  const memoryButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const townButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const panelRequestRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [statusMessage, setStatusMessage] = useState<string>();
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [drawer, setDrawer] = useState<DrawerName>();
  const [messages, setMessages] = useState<readonly MessageRecord[]>([]);
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [initializationError, setInitializationError] = useState<string>();
  const [panelError, setPanelError] = useState<{ drawer: DataDrawerName; message: string }>();
  const [town, setTown] = useState<TownSnapshotResponse>();
  const [inTown, setInTown] = useState(false);
  const [townBusy, setTownBusy] = useState(false);
  const [followTarget, setFollowTarget] = useState<string>();
  const [subtitle, setSubtitle] = useState<string>();
  const [townEvents, setTownEvents] = useState<readonly TownEvent[]>([]);
  const [relationships, setRelationships] = useState<readonly TownRelationship[]>([]);
  const [experienceCards, setExperienceCards] = useState<readonly ExperienceCard[]>([]);
  const [showcaseItems, setShowcaseItems] = useState<readonly PublicShowcaseItem[]>([]);

  const initializeRuntime = useCallback(async (runtime: GameUiRuntime) => {
    setStatus('connecting');
    cancelRequestedRef.current = false;
    setStatusMessage(undefined);
    setInitializationError(undefined);
    setHasSession(false);
    try {
      const snapshot = await runtime.initialize(safeStorageGet(SESSION_STORAGE_KEY));
      if (!mountedRef.current) return;
      safeStorageSet(SESSION_STORAGE_KEY, snapshot.sessionId);
      setMessages(snapshot.messages);
      setTown(snapshot.town);
      setShowcaseItems(snapshot.town?.showcaseItems ?? []);
      setExperienceCards(snapshot.town?.experienceCards ?? []);
      const player = snapshot.town?.projection.residents.find(({ pet }) => pet.source === 'player-pet');
      setFollowTarget(player?.residentId);
      setInTown(snapshot.town?.outings.some((outing) => outing.residentId === player?.residentId && outing.status !== 'home') ?? false);
      setHasSession(true);
      setStatus('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      const message = errorMessage(error, 'Unable to start a session');
      setInitializationError(message);
      setStatus('offline');
      setStatusMessage(message);
    }
  }, []);

  useEffect(() => {
    const parent = gameParentRef.current;
    if (!parent || runtimeRef.current) return undefined;
    const runtime = runtimeFactory(parent);
    runtimeRef.current = runtime;
    mountedRef.current = true;
    const offStatus = runtime.events.on('connection-status', (next) => {
      if (cancelRequestedRef.current && next.status !== 'cancelled') return;
      setStatus(next.status);
      setStatusMessage(next.message);
    });
    const offSubtitle = runtime.events.on('town-subtitle', ({ text }) => setSubtitle(text));
    const offFollow = runtime.events.on('town-follow-changed', ({ residentId }) => setFollowTarget(residentId));
    void initializeRuntime(runtime);
    return () => {
      mountedRef.current = false;
      panelRequestRef.current += 1;
      offStatus();
      offSubtitle();
      offFollow();
      runtime.destroy();
      runtimeRef.current = undefined;
    };
  }, [initializeRuntime, runtimeFactory]);

  const busy = submitting || status === 'thinking' || status === 'acting';
  const unavailable = status === 'connecting' || !hasSession;

  const submit = async () => {
    const runtime = runtimeRef.current;
    const message = draft.trim();
    if (!runtime || !message || busy || unavailable) return;
    cancelRequestedRef.current = false;
    setSubmitting(true);
    try {
      const outcome = await runtime.sendMessage(message);
      if (outcome.accepted) {
        setDraft('');
        setMessages(await runtime.loadConversation());
      }
    } catch {
      // Status is emitted by the bridge; the draft remains available for retry.
    } finally {
      setSubmitting(false);
    }
  };

  const openDrawer = async (name: DrawerName) => {
    setDrawer(name);
    if (name === 'settings') return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const requestId = ++panelRequestRef.current;
    setPanelError(undefined);
    setPanelLoading(true);
    try {
      if (name === 'conversation') {
        const nextMessages = await runtime.loadConversation();
        if (requestId === panelRequestRef.current) setMessages(nextMessages);
      } else if (name === 'memory') {
        const nextMemories = await runtime.loadMemories();
        if (requestId === panelRequestRef.current) setMemories(nextMemories);
      } else if (name === 'town-history') {
        const result = await runtime.loadTownHistory?.();
        if (requestId === panelRequestRef.current && result) { setTownEvents(result.events); setExperienceCards(result.experienceCards); }
      } else if (name === 'relationships') {
        const result = await runtime.loadTownRelationships?.();
        if (requestId === panelRequestRef.current && result) setRelationships(result);
      } else if (name === 'experiences') {
        const result = await runtime.loadExperienceCards?.();
        if (requestId === panelRequestRef.current && result) setExperienceCards(result);
      } else if (name === 'showcase') {
        const result = await runtime.loadShowcase?.();
        if (requestId === panelRequestRef.current && result) setShowcaseItems(result);
      }
    } catch (error) {
      if (requestId === panelRequestRef.current) {
        setPanelError({ drawer: name, message: errorMessage(error, `Unable to load ${name}`) });
      }
    } finally {
      if (requestId === panelRequestRef.current) setPanelLoading(false);
    }
  };

  const closeDrawer = useCallback(() => {
    panelRequestRef.current += 1;
    setDrawer(undefined);
    setPanelError(undefined);
    setPanelLoading(false);
  }, []);
  const toggleMuted = (nextMuted: boolean) => {
    setMuted(nextMuted);
    runtimeRef.current?.setMuted(nextMuted);
  };
  const cancel = () => {
    cancelRequestedRef.current = true;
    runtimeRef.current?.cancel();
    setStatus('cancelled');
    setStatusMessage(undefined);
  };
  const toggleTown = async () => {
    const runtime = runtimeRef.current;
    if (!runtime || townBusy) return;
    setTownBusy(true);
    try {
      const next = inTown ? await runtime.recallPet?.() : await runtime.releasePet?.();
      if (next) { setTown(next); setInTown(!inTown); setShowcaseItems(next.showcaseItems); setExperienceCards(next.experienceCards); }
    } finally { setTownBusy(false); }
  };

  const returnFocusRef = drawer === 'memory'
    ? memoryButtonRef
    : drawer === 'settings'
      ? settingsButtonRef
      : drawer && drawer.startsWith('town') || drawer === 'relationships' || drawer === 'experiences' || drawer === 'showcase'
        ? townButtonRef
        : conversationButtonRef;

  return (
    <main id="app" className="game-shell">
      <div
        className="app-content"
        data-testid="app-content"
        aria-hidden={drawer === undefined ? undefined : true}
        inert={drawer === undefined ? undefined : true}
      >
        <div ref={gameParentRef} className="game-surface" data-testid="game-surface" aria-label="Pixel art cat house" />
        <div className="ui-overlay">
        <div className="top-rail">
          <StatusBar status={status} {...(statusMessage === undefined ? {} : { message: statusMessage })} />
          {initializationError ? (
            <button className="retry-button" type="button" onClick={() => runtimeRef.current && void initializeRuntime(runtimeRef.current)} aria-label="Retry connection">
              <RefreshCw aria-hidden="true" />
              <span>Retry</span>
            </button>
          ) : null}
          <nav className="tool-strip" aria-label="Game panels and sound">
            {town ? <TownControls inTown={inTown} released={inTown} residents={town.projection.residents} {...(followTarget ? { followTarget } : {})} disabled={townBusy} onRelease={() => void toggleTown()} onRecall={() => void toggleTown()} onFollow={(id) => runtimeRef.current?.followTownResident?.(id)} /> : null}
            <ToolButton ref={conversationButtonRef} label="Open conversation" onClick={() => void openDrawer('conversation')}><MessageCircle /></ToolButton>
            <ToolButton ref={memoryButtonRef} label="Open memories" onClick={() => void openDrawer('memory')}><Brain /></ToolButton>
            <ToolButton ref={settingsButtonRef} label="Open settings" onClick={() => void openDrawer('settings')}><Settings /></ToolButton>
            <ToolButton label={muted ? 'Turn sound on' : 'Mute sound'} onClick={() => toggleMuted(!muted)}>{muted ? <VolumeX /> : <Volume2 />}</ToolButton>
          </nav>
        </div>
        {town ? <nav className="town-tool-strip" aria-label="小镇观察面板">
          <ToolButton ref={townButtonRef} label="小镇动态" onClick={() => void openDrawer('town-history')}><BookOpen /></ToolButton>
          <ToolButton label="居民关系" onClick={() => void openDrawer('relationships')}><Heart /></ToolButton>
          <ToolButton label="旅行见闻" onClick={() => void openDrawer('experiences')}><Images /></ToolButton>
          <ToolButton label="个性展摊" onClick={() => void openDrawer('showcase')}><Store /></ToolButton>
        </nav> : null}
        {subtitle ? <div className="town-subtitle" role="status">{subtitle}</div> : null}
        <CommandDock
          draft={draft}
          busy={busy}
          disabled={busy || unavailable}
          onDraftChange={setDraft}
          onSubmit={() => void submit()}
          onCancel={cancel}
        />
        </div>
      </div>
      <Drawer title="Conversation" open={drawer === 'conversation'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>
        {panelError?.drawer === 'conversation'
          ? <PanelError message={panelError.message} retryLabel="Retry conversation" onRetry={() => void openDrawer('conversation')} />
          : <ConversationPanel messages={messages} loading={panelLoading} />}
      </Drawer>
      <Drawer title="Memories" open={drawer === 'memory'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>
        {panelError?.drawer === 'memory'
          ? <PanelError message={panelError.message} retryLabel="Retry memories" onRetry={() => void openDrawer('memory')} />
          : <MemoryPanel memories={memories} loading={panelLoading} />}
      </Drawer>
      <Drawer title="Settings" open={drawer === 'settings'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>
        <SettingsPanel apiUrl={runtimeRef.current?.apiUrl ?? ''} status={status} muted={muted} onMutedChange={toggleMuted} />
      </Drawer>
      <Drawer title="小镇动态" open={drawer === 'town-history'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>{panelError?.drawer === 'town-history' ? <PanelError message={panelError.message} retryLabel="重试" onRetry={() => void openDrawer('town-history')} /> : <TownHistoryPanel events={townEvents} residents={town?.projection.residents ?? []} loading={panelLoading} />}</Drawer>
      <Drawer title="居民关系" open={drawer === 'relationships'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>{panelError?.drawer === 'relationships' ? <PanelError message={panelError.message} retryLabel="重试" onRetry={() => void openDrawer('relationships')} /> : <RelationshipsPanel relationships={relationships} residents={town?.projection.residents ?? []} loading={panelLoading} />}</Drawer>
      <Drawer title="旅行见闻" open={drawer === 'experiences'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>{panelError?.drawer === 'experiences' ? <PanelError message={panelError.message} retryLabel="重试" onRetry={() => void openDrawer('experiences')} /> : <ExperiencePanel cards={experienceCards} loading={panelLoading} />}</Drawer>
      <Drawer title="个性展摊" open={drawer === 'showcase'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>{panelError?.drawer === 'showcase' ? <PanelError message={panelError.message} retryLabel="重试" onRetry={() => void openDrawer('showcase')} /> : <ShowcasePanel items={showcaseItems} sessionId={town?.projection.sessionId ?? ''} loading={panelLoading} onSave={async (item) => { const next = await runtimeRef.current?.saveShowcase?.(item); if (next) setShowcaseItems(next); }} onDelete={async (id) => { const next = await runtimeRef.current?.deleteShowcase?.(id); if (next) setShowcaseItems(next); }} />}</Drawer>
    </main>
  );
}

const ToolButton = forwardRef<HTMLButtonElement, { label: string; onClick: () => void; children: ReactNode }>(
  function ToolButton({ label, onClick, children }, ref) {
    return <button ref={ref} className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>{children}</button>;
  },
);

function PanelError({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div className="panel-error" role="alert">
      <p>{message}</p>
      <button className="panel-retry-button" type="button" onClick={onRetry}>{retryLabel}</button>
    </div>
  );
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
    // The active session remains usable in memory when storage is unavailable.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
