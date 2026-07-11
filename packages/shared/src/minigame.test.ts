import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  MiniGameManifestMetadataSchema,
  cloneMiniGameJsonValue,
  executeMiniGameAgentTool,
  getMiniGameManifestMetadata,
  validateMiniGameManifest,
  type MiniGameManifest,
  type MiniGameJsonValue,
} from './minigame.js';

const stateSchema = z.object({ visits: z.number().int().nonnegative() }).strict();

function manifest(overrides: Partial<MiniGameManifest<{ visits: number }, string>> = {}) {
  return {
    id: 'test-game',
    title: 'Test Game',
    triggerObjectId: 'arcade',
    stateSchemaId: 'test-game-state-v1',
    stateSchema,
    createInitialState: () => ({ visits: 0 }),
    loadScene: async () => 'TestScene',
    ...overrides,
  } satisfies MiniGameManifest<{ visits: number }, string>;
}

describe('mini-game manifests', () => {
  it('keeps wire-safe metadata separate from runtime functions and schemas', () => {
    const runtime = manifest();
    const metadata = getMiniGameManifestMetadata(runtime);

    expect(MiniGameManifestMetadataSchema.parse(metadata)).toEqual({
      id: 'test-game',
      title: 'Test Game',
      triggerObjectId: 'arcade',
      stateSchemaId: 'test-game-state-v1',
    });
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
    expect(metadata).not.toHaveProperty('stateSchema');
    expect(metadata).not.toHaveProperty('createInitialState');
    expect(metadata).not.toHaveProperty('loadScene');
  });

  it('validates runtime fields and verifies the initial state against its schema', () => {
    const runtime = manifest();
    expect(validateMiniGameManifest(runtime)).toBe(runtime);
    expect(() =>
      validateMiniGameManifest(
        manifest({ createInitialState: () => ({ visits: -1 }) }),
      ),
    ).toThrow(/initial state/i);
    expect(() =>
      validateMiniGameManifest({
        ...manifest(),
        loadScene: 'not-a-function',
      }),
    ).toThrow(/loadScene/i);
    expect(() =>
      validateMiniGameManifest({
        ...manifest(),
        stateSchema: z.unknown(),
        createInitialState: () => ({ invalid: undefined }) as unknown as MiniGameJsonValue,
      }),
    ).toThrow(/json-compatible/i);
  });

  it('bounds optional agent tools and requires schema-validated execution contracts', () => {
    const tool = {
      id: 'increment',
      description: 'Increment the visit counter once.',
      inputSchemaId: 'increment-input-v1',
      inputSchema: z.object({ amount: z.literal(1) }).strict(),
      execute: async ({ amount }: { amount: 1 }, state: Readonly<{ visits: number }>) => ({
        visits: state.visits + amount,
      }),
    };

    expect(validateMiniGameManifest(manifest({ agentTools: [tool] })).agentTools).toHaveLength(1);
    expect(() =>
      validateMiniGameManifest(manifest({ agentTools: Array.from({ length: 9 }, () => tool) })),
    ).toThrow(/agentTools|at most/i);
    expect(() =>
      validateMiniGameManifest({
        ...manifest(),
        agentTools: [{ ...tool, execute: 'unsafe' }],
      }),
    ).toThrow(/execute/i);
  });

  it('parses tool input and output state at the execution boundary', async () => {
    const runtime = manifest({
      agentTools: [
        {
          id: 'increment',
          description: 'Increment the visit counter once.',
          inputSchemaId: 'increment-input-v1',
          inputSchema: z.object({ amount: z.literal(1) }).strict(),
          execute: async ({ amount }: { amount: 1 }, state) => ({
            visits: state.visits + amount,
          }),
        },
      ],
    });

    await expect(
      executeMiniGameAgentTool(runtime, 'increment', { amount: 1 }, { visits: 2 }),
    ).resolves.toEqual({ visits: 3 });
    await expect(
      executeMiniGameAgentTool(runtime, 'increment', { amount: 2 }, { visits: 2 }),
    ).rejects.toThrow();
    await expect(
      executeMiniGameAgentTool(runtime, 'missing', {}, { visits: 2 }),
    ).rejects.toThrow(/unknown mini-game agent tool/i);
  });

  it('isolates caller-owned nested state and input when a tool mutates then fails', async () => {
    type NestedState = { nested: { visits: number } };
    type NestedInput = { payload: { amount: number } };
    const nestedStateSchema = {
      parse: (input: unknown) => input as NestedState,
    };
    const nestedInputSchema = {
      parse: (input: unknown) => input as NestedInput,
    };
    const runtime: MiniGameManifest<
      NestedState,
      string
    > = {
      id: 'nested-game',
      title: 'Nested Game',
      triggerObjectId: 'arcade',
      stateSchemaId: 'nested-state-v1',
      stateSchema: nestedStateSchema,
      createInitialState: () => ({ nested: { visits: 0 } }),
      loadScene: async () => 'NestedScene',
      agentTools: [
        {
          id: 'mutate',
          description: 'Attempts nested mutation before failing.',
          inputSchemaId: 'nested-input-v1',
          inputSchema: nestedInputSchema,
          execute: async (input: NestedInput, state) => {
            try {
              state.nested.visits = 99;
            } catch {
              // Frozen runtime copies may reject mutation before the tool failure.
            }
            try {
              input.payload.amount = 99;
            } catch {
              // Frozen runtime copies may reject mutation before the tool failure.
            }
            throw new Error('tool failed');
          },
        },
      ],
    };
    const callerState = { nested: { visits: 2 } };
    const callerInput = { payload: { amount: 1 } };

    await expect(
      executeMiniGameAgentTool(runtime, 'mutate', callerInput, callerState),
    ).rejects.toThrow('tool failed');

    expect(callerState).toEqual({ nested: { visits: 2 } });
    expect(callerInput).toEqual({ payload: { amount: 1 } });
  });

  it('preserves dangerous JSON keys without prototype pollution and freezes tool copies', async () => {
    type DangerousState = {
      __proto__: { polluted: boolean };
      constructor: { x: number };
    };
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"x":1}}',
    ) as DangerousState;
    const cloned = cloneMiniGameJsonValue<DangerousState>(source);

    expect(Object.getPrototypeOf(cloned)).toBeNull();
    expect(Object.keys(cloned)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
    expect(cloned.__proto__).toEqual({ polluted: true });
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();

    const identity = { parse: (input: unknown) => input as DangerousState };
    const runtime: MiniGameManifest<DangerousState, string> = {
      id: 'dangerous-keys-game',
      title: 'Dangerous Keys Game',
      triggerObjectId: 'arcade',
      stateSchemaId: 'dangerous-state-v1',
      stateSchema: identity,
      createInitialState: () => source,
      loadScene: async () => 'DangerousScene',
      agentTools: [
        {
          id: 'inspect-keys',
          description: 'Verifies isolated JSON keys.',
          inputSchemaId: 'dangerous-input-v1',
          inputSchema: identity,
          execute: async (input: DangerousState, state) => {
            expect(Object.hasOwn(state, '__proto__')).toBe(true);
            expect(Object.hasOwn(input, '__proto__')).toBe(true);
            expect(Object.isFrozen(state)).toBe(true);
            expect(Object.isFrozen(state.__proto__)).toBe(true);
            expect(Object.isFrozen(state.constructor)).toBe(true);
            expect(Object.isFrozen(input.__proto__)).toBe(true);
            return state;
          },
        },
      ],
    };

    const result = await executeMiniGameAgentTool(runtime, 'inspect-keys', source, source);

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__.polluted).toBe(true);
    expect(Object.isFrozen(source.__proto__)).toBe(false);
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
