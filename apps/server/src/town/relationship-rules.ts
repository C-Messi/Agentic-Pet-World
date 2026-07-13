const AFFINITY_STEP = 0.05;
const AFFINITY_PRECISION = 1_000_000;

export interface AutonomousPlayRelationshipChange {
  readonly affinity: number;
  readonly delta: number;
}

export function autonomousPlayRelationshipChange(
  currentAffinity: number,
): AutonomousPlayRelationshipChange {
  if (
    !Number.isFinite(currentAffinity) ||
    currentAffinity < -1 ||
    currentAffinity > 1
  ) {
    throw new RangeError(
      'Current relationship affinity must be between -1 and 1',
    );
  }
  const affinity = roundAffinity(Math.min(1, currentAffinity + AFFINITY_STEP));
  const rawDelta = affinity - currentAffinity;
  const roundedDelta = roundAffinity(rawDelta);
  return {
    affinity,
    delta: rawDelta !== 0 && roundedDelta === 0 ? rawDelta : roundedDelta,
  };
}

function roundAffinity(value: number): number {
  return Math.round(value * AFFINITY_PRECISION) / AFFINITY_PRECISION;
}
