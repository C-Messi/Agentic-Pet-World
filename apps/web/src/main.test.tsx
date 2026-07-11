import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./game/production-runtime', () => ({
  createProductionRuntime: () => ({
    events: { on: () => () => undefined },
    apiUrl: '',
    initialize: async () => ({ sessionId: 'session-test', messages: [] }),
    sendMessage: async () => ({ accepted: true }),
    cancel: () => undefined,
    loadConversation: async () => [],
    loadMemories: async () => [],
    setMuted: () => undefined,
    destroy: () => undefined,
  }),
}));

describe('web bootstrap', () => {
  it('mounts the application root', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('./main');

    await waitFor(() => {
      expect(document.querySelector('#root > #app .game-surface')).not.toBeNull();
    });
  });
});
