import { describe, expect, it } from 'vitest';

import {
  ActionResultsRequestSchema,
  ActionResultSchema,
  AgentActionSchema,
  AgentDecisionSchema,
  AgentTurnRequestSchema,
  AgentTurnResponseSchema,
  CreateSessionRequestSchema,
  EmotionSchema,
  ErrorResponseSchema,
  MemoryCandidateSchema,
  WorldSnapshotSchema,
} from './index.js';

const world = {
  cat: {
    position: { x: 4, y: 7 },
    emotion: 'curious',
  },
  objects: [
    {
      id: 'window',
      position: { x: 8, y: 2 },
      available: true,
      interactions: ['inspect', 'open'],
    },
  ],
};

const validDecision = {
  speech: 'Let me take a look.',
  thought: 'The light looks interesting.',
  emotion: 'curious',
  actions: [
    { id: 'action-1', type: 'move_to', targetId: 'window', timeoutMs: 5_000 },
    { id: 'action-2', type: 'interact', targetId: 'window', interaction: 'inspect' },
  ],
  memoryCandidates: [
    { content: 'The player likes sunny windows.', importance: 0.8 },
  ],
};

const validResult = {
  actionId: 'action-1',
  type: 'move_to',
  status: 'succeeded',
  message: 'Reached the window.',
  completedAt: '2026-07-12T08:30:00.000Z',
};

describe('emotions', () => {
  it('exposes exactly the planned sprite states', () => {
    expect(EmotionSchema.options).toEqual([
      'idle',
      'walk',
      'sit',
      'sleep',
      'happy',
      'curious',
      'confused',
    ]);
  });
});

describe('agent decisions', () => {
  it('accepts a bounded decision with known actions', () => {
    expect(AgentDecisionSchema.parse(validDecision)).toEqual(validDecision);
  });

  it('accepts omitted thought and memory candidates', () => {
    const decision = {
      speech: 'I will stay here.',
      emotion: 'idle',
      actions: [],
    };

    expect(AgentDecisionSchema.parse(decision)).toEqual(decision);
  });

  it('rejects a fifth action', () => {
    const actions = Array.from({ length: 5 }, (_, index) => ({
      id: `wait-${index}`,
      type: 'wait',
      durationMs: 500,
    }));

    expect(() => AgentDecisionSchema.parse({ ...validDecision, actions })).toThrow();
  });

  it('rejects otherwise-valid actions with duplicate IDs', () => {
    const actions = [
      { id: 'duplicate-action', type: 'wait', durationMs: 500 },
      { id: 'duplicate-action', type: 'wait', durationMs: 1_000 },
    ];

    expect(() => AgentDecisionSchema.parse({ ...validDecision, actions })).toThrow();
  });

  it('accepts the canonical rug target and rejects unknown action types and targets', () => {
    expect(
      AgentActionSchema.parse({
        id: 'rug-rest',
        type: 'interact',
        targetId: 'rug',
        interaction: 'rest',
      }),
    ).toMatchObject({ targetId: 'rug' });
    expect(() => AgentActionSchema.parse({ id: 'bad-1', type: 'run_code' })).toThrow();
    expect(() =>
      AgentActionSchema.parse({
        id: 'bad-2',
        type: 'move_to',
        targetId: 'desk',
        timeoutMs: 1_000,
      }),
    ).toThrow();
  });

  it('rejects invalid action timeouts, durations, and text', () => {
    expect(() =>
      AgentActionSchema.parse({
        id: 'move-1',
        type: 'move_to',
        targetId: 'bed',
        timeoutMs: 60_001,
      }),
    ).toThrow();
    expect(() =>
      AgentActionSchema.parse({ id: 'wait-1', type: 'wait', durationMs: 0 }),
    ).toThrow();
    expect(() =>
      AgentActionSchema.parse({ id: 'speak-1', type: 'speak', text: '' }),
    ).toThrow();
    expect(() =>
      AgentDecisionSchema.parse({ ...validDecision, speech: 'x'.repeat(281) }),
    ).toThrow();
  });

  it('rejects unknown decision fields and oversized action IDs', () => {
    expect(() =>
      AgentDecisionSchema.parse({ ...validDecision, executableCode: 'open()' }),
    ).toThrow();
    expect(() =>
      AgentActionSchema.parse({
        id: 'a'.repeat(65),
        type: 'wait',
        durationMs: 500,
      }),
    ).toThrow();
  });
});

describe('world snapshots', () => {
  it('accepts all eight canonical room objects', () => {
    const ids = [
      'bed',
      'sofa',
      'rug',
      'window',
      'food-bowl',
      'bookshelf',
      'toy-basket',
      'arcade',
    ];
    const objects = ids.map((id, index) => ({
      id,
      position: { x: index, y: 1 },
      available: true,
      interactions: ['inspect'],
    }));

    expect(WorldSnapshotSchema.parse({ ...world, objects }).objects).toHaveLength(8);
  });

  it('rejects duplicate object IDs within the object limit', () => {
    const objects = [
      {
        id: 'bed',
        position: { x: 1, y: 1 },
        available: true,
        interactions: ['rest'],
      },
      {
        id: 'bed',
        position: { x: 2, y: 1 },
        available: true,
        interactions: ['inspect'],
      },
    ];

    expect(() => WorldSnapshotSchema.parse({ ...world, objects })).toThrow();
  });
});

describe('memory candidates', () => {
  it('rejects importance outside the normalized range', () => {
    expect(() =>
      MemoryCandidateSchema.parse({ content: 'Remember this.', importance: 1.01 }),
    ).toThrow();
    expect(() =>
      MemoryCandidateSchema.parse({ content: 'Remember this.', importance: -0.01 }),
    ).toThrow();
  });
});

describe('agent turn requests', () => {
  it('accepts optional current action and recent results', () => {
    const request = {
      sessionId: 'session-1',
      playerMessage: 'Please look out of the window.',
      world,
      currentAction: validDecision.actions[0],
      recentActionResults: [validResult],
    };

    expect(AgentTurnRequestSchema.parse(request)).toEqual(request);
  });

  it('accepts a compact request without a current action', () => {
    const request = {
      sessionId: 'session-1',
      playerMessage: 'How are you?',
      world,
      recentActionResults: [],
    };

    expect(AgentTurnRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects oversized messages, snapshots, and result histories', () => {
    expect(() =>
      AgentTurnRequestSchema.parse({
        sessionId: 'session-1',
        playerMessage: 'x'.repeat(1_001),
        world,
        recentActionResults: [],
      }),
    ).toThrow();

    const tooManyObjects = Array.from({ length: 9 }, (_, index) => ({
      id: 'bed',
      position: { x: index, y: 0 },
      available: true,
      interactions: ['rest'],
    }));
    expect(() => WorldSnapshotSchema.parse({ ...world, objects: tooManyObjects })).toThrow();

    expect(() =>
      AgentTurnRequestSchema.parse({
        sessionId: 'session-1',
        playerMessage: 'What happened?',
        world,
        recentActionResults: Array.from({ length: 13 }, (_, index) => ({
          ...validResult,
          actionId: `action-${index}`,
        })),
      }),
    ).toThrow();
  });
});

describe('action results', () => {
  it('supports an optional bounded error code', () => {
    const result = {
      actionId: 'action-2',
      type: 'interact',
      status: 'failed',
      errorCode: 'OBJECT_UNAVAILABLE',
      completedAt: '2026-07-12T08:30:00.000Z',
    };

    expect(ActionResultSchema.parse(result)).toEqual(result);
  });

  it('rejects invalid result text and identifiers', () => {
    expect(() => ActionResultSchema.parse({ ...validResult, actionId: '' })).toThrow();
    expect(() =>
      ActionResultSchema.parse({ ...validResult, message: 'x'.repeat(501) }),
    ).toThrow();
  });
});

describe('HTTP API envelopes', () => {
  it('validates session, turn, action-result, and error payloads', () => {
    expect(CreateSessionRequestSchema.parse({})).toEqual({});
    expect(
      AgentTurnResponseSchema.parse({
        decision: validDecision,
        degraded: true,
        fallbackReason: 'provider_unavailable',
        correlationId: 'request-1',
      }),
    ).toEqual({
      decision: validDecision,
      degraded: true,
      fallbackReason: 'provider_unavailable',
      correlationId: 'request-1',
    });
    expect(
      ActionResultsRequestSchema.parse({
        turnCorrelationId: 'turn-request-1',
        world,
        results: [validResult],
      }),
    ).toEqual({
      turnCorrelationId: 'turn-request-1',
      world,
      results: [validResult],
    });
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is invalid',
          correlationId: 'request-1',
          details: [{ path: 'playerMessage', message: 'Required' }],
        },
      }),
    ).toBeTruthy();
    expect(() =>
      ActionResultsRequestSchema.parse({ world, results: [validResult] }),
    ).toThrow();
  });
});
