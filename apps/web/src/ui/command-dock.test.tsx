import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemoryRecord, MessageRecord } from '@cat-house/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, type GameUiRuntime, type RuntimeSnapshot } from '../App';
import { GameEventBus } from '../game/events';

const timestamp = '2026-07-12T08:30:00.000Z';
const messages: MessageRecord[] = [
  {
    id: 'message-1',
    sessionId: 'session-1',
    role: 'player',
    content: 'Please sit by the window.',
    createdAt: timestamp,
  },
  {
    id: 'message-2',
    sessionId: 'session-1',
    role: 'agent',
    content: 'The sunlight looks perfect.',
    createdAt: timestamp,
  },
];
const memories: MemoryRecord[] = [
  {
    id: 'memory-1',
    sessionId: 'session-1',
    content: 'The player likes sunny windows.',
    importance: 0.86,
    sourceMessageId: 'message-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('natural language game interface', () => {
  it('submits a command, disables while busy, and clears only an accepted draft', async () => {
    const pending = deferred<{ accepted: boolean }>();
    const runtime = createRuntime({ sendMessage: vi.fn(() => pending.promise) });
    render(<App runtimeFactory={() => runtime} />);
    await screen.findByText('Ready');

    const input = screen.getByLabelText('Tell the cat what to do');
    fireEvent.change(input, { target: { value: '  Inspect the bookshelf  ' } });
    fireEvent.submit(input.closest('form')!);

    expect(runtime.sendMessage).toHaveBeenCalledWith('Inspect the bookshelf');
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel current request' })).toBeVisible();
    pending.resolve({ accepted: true });

    await waitFor(() => expect(input).toHaveValue(''));
    expect(input).not.toBeDisabled();
  });

  it('cancels a busy command and preserves drafts on network failure', async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(async () => {
      runtime.events.emit('connection-status', { status: 'offline' });
      throw new TypeError('Network unavailable');
    });
    render(<App runtimeFactory={() => runtime} />);
    await screen.findByText('Ready');
    const input = screen.getByLabelText('Tell the cat what to do');
    fireEvent.change(input, { target: { value: 'Stay near the very comfortable window seat' } });
    fireEvent.submit(input.closest('form')!);

    await screen.findByText('Offline');
    expect(input).toHaveValue('Stay near the very comfortable window seat');

    await act(async () => {
      runtime.events.emit('connection-status', { status: 'thinking' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel current request' }));
    expect(runtime.cancel).toHaveBeenCalledOnce();
  });

  it('opens drawers, renders conversation and memory details, and returns focus', async () => {
    const runtime = createRuntime();
    render(<App runtimeFactory={() => runtime} />);
    await screen.findByText('Ready');

    const conversationButton = screen.getByRole('button', { name: 'Open conversation' });
    conversationButton.focus();
    fireEvent.click(conversationButton);
    expect(await screen.findByText('Please sit by the window.')).toBeVisible();
    expect(screen.getByText('The sunlight looks perfect.')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(conversationButton).toHaveFocus());

    const memoryButton = screen.getByRole('button', { name: 'Open memories' });
    fireEvent.click(memoryButton);
    expect(await screen.findByText('The player likes sunny windows.')).toBeVisible();
    expect(screen.getByText('86% importance')).toBeVisible();
    expect(screen.getByText('Conversation source')).toBeVisible();
  });

  it('shows status transitions and production settings without covering the game', async () => {
    const runtime = createRuntime({ apiUrl: 'https://example.test/a/very/long/provider/path' });
    render(<App runtimeFactory={() => runtime} />);
    expect(screen.getByText('Connecting')).toBeVisible();
    await screen.findByText('Ready');

    for (const status of ['thinking', 'acting', 'offline', 'cancelled', 'provider-error'] as const) {
      runtime.events.emit('connection-status', { status });
      expect(await screen.findByText(statusLabel(status))).toBeVisible();
    }

    runtime.events.emit('connection-status', { status: 'ready' });
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByText('https://example.test/a/very/long/provider/path')).toBeVisible();
    expect(screen.getByText('Configured on server')).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveClass('edge-drawer');
    expect(screen.getByTestId('game-surface')).toHaveClass('game-surface');
  });

  it('restores a local session and destroys one runtime on cleanup', async () => {
    localStorage.setItem('agent-cat-house.session-id', 'session-restored');
    const runtime = createRuntime();
    const factory = vi.fn(() => runtime);
    const subscribe = vi.spyOn(runtime.events, 'on');
    const view = render(<App runtimeFactory={factory} />);
    await screen.findByText('Ready');

    expect(runtime.initialize).toHaveBeenCalledWith('session-restored');
    expect(localStorage.getItem('agent-cat-house.session-id')).toBe('session-1');
    expect(factory).toHaveBeenCalledOnce();
    view.rerender(<App runtimeFactory={factory} />);
    expect(factory).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    view.unmount();
    expect(runtime.destroy).toHaveBeenCalledOnce();
  });

  it('keeps commands disabled after initialization failure and retries successfully', async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.initialize)
      .mockRejectedValueOnce(new TypeError('Server unavailable'))
      .mockResolvedValueOnce({ sessionId: 'session-retry', messages: [] });
    render(<App runtimeFactory={() => runtime} />);

    expect(await screen.findByRole('button', { name: 'Retry connection' })).toBeVisible();
    expect(screen.getByLabelText('Tell the cat what to do')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByText('Ready');
    expect(runtime.initialize).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Tell the cat what to do')).not.toBeDisabled();
  });

  it('continues with in-memory session state when localStorage throws', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const runtime = createRuntime();
    const view = render(<App runtimeFactory={() => runtime} />);

    await screen.findByText('Ready');
    expect(runtime.initialize).toHaveBeenCalledWith(undefined);
    expect(screen.getByLabelText('Tell the cat what to do')).not.toBeDisabled();
    view.unmount();
    expect(runtime.destroy).toHaveBeenCalledOnce();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('traps focus, makes background inert, and restores focus on close', async () => {
    const runtime = createRuntime();
    render(<App runtimeFactory={() => runtime} />);
    await screen.findByText('Ready');
    const opener = screen.getByRole('button', { name: 'Open settings' });
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close settings' });
    const sound = screen.getByRole('checkbox');
    const background = screen.getByTestId('app-content');

    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(dialog).toBeVisible();
    expect(background).toHaveAttribute('inert');
    sound.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    opener.focus();
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(background).not.toHaveAttribute('aria-hidden');
  });

  it('renders drawer fetch errors and retries without an unhandled rejection', async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.loadMemories)
      .mockRejectedValueOnce(new TypeError('Memory service offline'))
      .mockResolvedValueOnce(memories);
    render(<App runtimeFactory={() => runtime} />);
    await screen.findByText('Ready');
    fireEvent.click(screen.getByRole('button', { name: 'Open memories' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Memory service offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry memories' }));
    expect(await screen.findByText('The player likes sunny windows.')).toBeVisible();
    expect(runtime.loadMemories).toHaveBeenCalledTimes(2);
  });
});

function createRuntime(overrides: Partial<GameUiRuntime> = {}): GameUiRuntime {
  const snapshot: RuntimeSnapshot = { sessionId: 'session-1', messages };
  return {
    events: new GameEventBus(),
    apiUrl: '',
    initialize: vi.fn(async () => snapshot),
    sendMessage: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(),
    loadConversation: vi.fn(async () => messages),
    loadMemories: vi.fn(async () => memories),
    setMuted: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function statusLabel(status: string): string {
  if (status === 'cancelled') return 'Canceled';
  return status === 'provider-error'
    ? 'Provider error'
    : status.charAt(0).toUpperCase() + status.slice(1);
}
