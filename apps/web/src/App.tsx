import type { MemoryRecord, MessageRecord } from '@cat-house/shared';
import { Brain, MessageCircle, Settings, Volume2, VolumeX } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { ConnectionStatus, GameEventBus } from './game/events';
import { CommandDock } from './ui/command-dock';
import { ConversationPanel } from './ui/conversation-panel';
import { Drawer } from './ui/drawer';
import { MemoryPanel } from './ui/memory-panel';
import { SettingsPanel } from './ui/settings-panel';
import { StatusBar } from './ui/status-bar';

export const SESSION_STORAGE_KEY = 'agent-cat-house.session-id';

export interface RuntimeSnapshot {
  sessionId: string;
  messages: readonly MessageRecord[];
}

export interface GameUiRuntime {
  readonly events: GameEventBus;
  readonly apiUrl: string;
  initialize(storedSessionId?: string): Promise<RuntimeSnapshot>;
  sendMessage(message: string): Promise<{ accepted: boolean }>;
  cancel(): void;
  loadConversation(): Promise<readonly MessageRecord[]>;
  loadMemories(): Promise<readonly MemoryRecord[]>;
  setMuted(muted: boolean): void;
  destroy(): void;
}

export type RuntimeFactory = (gameParent: HTMLElement) => GameUiRuntime;
type DrawerName = 'conversation' | 'memory' | 'settings';

export function App({ runtimeFactory }: { runtimeFactory: RuntimeFactory }) {
  const gameParentRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<GameUiRuntime | undefined>(undefined);
  const conversationButtonRef = useRef<HTMLButtonElement>(null);
  const memoryButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [statusMessage, setStatusMessage] = useState<string>();
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [drawer, setDrawer] = useState<DrawerName>();
  const [messages, setMessages] = useState<readonly MessageRecord[]>([]);
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const parent = gameParentRef.current;
    if (!parent || runtimeRef.current) return undefined;
    const runtime = runtimeFactory(parent);
    runtimeRef.current = runtime;
    const offStatus = runtime.events.on('connection-status', (next) => {
      setStatus(next.status);
      setStatusMessage(next.message);
    });
    const storedSessionId = localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined;
    void runtime.initialize(storedSessionId).then((snapshot) => {
      localStorage.setItem(SESSION_STORAGE_KEY, snapshot.sessionId);
      setMessages(snapshot.messages);
      setStatus('ready');
      setStatusMessage(undefined);
    }).catch(() => undefined);
    return () => {
      offStatus();
      runtime.destroy();
      runtimeRef.current = undefined;
    };
  }, [runtimeFactory]);

  const busy = submitting || status === 'thinking' || status === 'acting';
  const unavailable = status === 'connecting';

  const submit = async () => {
    const runtime = runtimeRef.current;
    const message = draft.trim();
    if (!runtime || !message || busy || unavailable) return;
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
    setPanelLoading(true);
    try {
      if (name === 'conversation') setMessages(await runtime.loadConversation());
      else setMemories(await runtime.loadMemories());
    } finally {
      setPanelLoading(false);
    }
  };

  const closeDrawer = useCallback(() => setDrawer(undefined), []);
  const toggleMuted = (nextMuted: boolean) => {
    setMuted(nextMuted);
    runtimeRef.current?.setMuted(nextMuted);
  };

  const returnFocusRef = drawer === 'memory'
    ? memoryButtonRef
    : drawer === 'settings'
      ? settingsButtonRef
      : conversationButtonRef;

  return (
    <main id="app" className="game-shell">
      <div ref={gameParentRef} className="game-surface" data-testid="game-surface" aria-label="Pixel art cat house" />
      <div className="ui-overlay">
        <div className="top-rail">
          <StatusBar status={status} {...(statusMessage === undefined ? {} : { message: statusMessage })} />
          <nav className="tool-strip" aria-label="Game panels and sound">
            <ToolButton ref={conversationButtonRef} label="Open conversation" onClick={() => void openDrawer('conversation')}><MessageCircle /></ToolButton>
            <ToolButton ref={memoryButtonRef} label="Open memories" onClick={() => void openDrawer('memory')}><Brain /></ToolButton>
            <ToolButton ref={settingsButtonRef} label="Open settings" onClick={() => void openDrawer('settings')}><Settings /></ToolButton>
            <ToolButton label={muted ? 'Turn sound on' : 'Mute sound'} onClick={() => toggleMuted(!muted)}>{muted ? <VolumeX /> : <Volume2 />}</ToolButton>
          </nav>
        </div>
        <CommandDock
          draft={draft}
          busy={busy}
          disabled={busy || unavailable}
          onDraftChange={setDraft}
          onSubmit={() => void submit()}
          onCancel={() => runtimeRef.current?.cancel()}
        />
      </div>
      <Drawer title="Conversation" open={drawer === 'conversation'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>
        <ConversationPanel messages={messages} loading={panelLoading} />
      </Drawer>
      <Drawer title="Memories" open={drawer === 'memory'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>
        <MemoryPanel memories={memories} loading={panelLoading} />
      </Drawer>
      <Drawer title="Settings" open={drawer === 'settings'} onClose={closeDrawer} returnFocusRef={returnFocusRef}>
        <SettingsPanel apiUrl={runtimeRef.current?.apiUrl ?? ''} status={status} muted={muted} onMutedChange={toggleMuted} />
      </Drawer>
    </main>
  );
}

const ToolButton = forwardRef<HTMLButtonElement, { label: string; onClick: () => void; children: ReactNode }>(
  function ToolButton({ label, onClick, children }, ref) {
    return <button ref={ref} className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>{children}</button>;
  },
);
