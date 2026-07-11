import type {
  AmbientAction,
  AmbientBehaviorSystem,
  AmbientContext,
} from './ambient-behavior';

export function evaluateAmbientBehavior(
  system: AmbientBehaviorSystem,
  agentBusy: boolean,
  buildContext: () => AmbientContext,
): AmbientAction | null {
  if (!system.isEligible(agentBusy)) return null;
  return system.select(buildContext());
}
