import type { AgentDecision } from '@cat-house/shared';

import type {
  ProviderAdapter,
  ProviderCompletionRequest,
} from './provider.js';

const WINDOW_DECISION: AgentDecision = {
  speech: 'I will take a look by the window.',
  emotion: 'curious',
  actions: [
    {
      id: 'fake-window-move',
      type: 'move_to',
      targetId: 'window',
      timeoutMs: 8_000,
    },
  ],
};

const BED_DECISION: AgentDecision = {
  speech: 'A soft bed sounds good right now.',
  emotion: 'happy',
  actions: [
    {
      id: 'fake-bed-move',
      type: 'move_to',
      targetId: 'bed',
      timeoutMs: 8_000,
    },
  ],
};

const ARCADE_DECISION: AgentDecision = {
  speech: 'The arcade games are coming soon. I can admire the cabinet for now.',
  emotion: 'curious',
  actions: [],
};

const GENERAL_DECISION: AgentDecision = {
  speech: 'I am listening. Let us enjoy the room together.',
  emotion: 'happy',
  actions: [],
};

export class FakeProvider implements ProviderAdapter {
  public async complete(request: ProviderCompletionRequest): Promise<unknown> {
    const latestMessage = request.messages.at(-1)?.content.toLocaleLowerCase() ?? '';
    if (latestMessage.includes('window')) {
      return WINDOW_DECISION;
    }
    if (latestMessage.includes('bed')) {
      return BED_DECISION;
    }
    if (latestMessage.includes('arcade')) {
      return ARCADE_DECISION;
    }
    return GENERAL_DECISION;
  }
}
