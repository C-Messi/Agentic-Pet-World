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
  const current = roundAffinity(currentAffinity);
  const affinity = roundAffinity(Math.min(1, current + AFFINITY_STEP));
  return {
    affinity,
    delta: roundAffinity(affinity - current),
  };
}

function roundAffinity(value: number): number {
  return Math.round(value * AFFINITY_PRECISION) / AFFINITY_PRECISION;
}
