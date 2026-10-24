/**
 * Smooth weighted round robin (the nginx algorithm), materialized as a fixed schedule.
 *
 * Weights 5/3/2 produce the 10-slot schedule A B C A A B A C B A: every window of
 * Σweights consecutive picks contains each target exactly `weight` times, and picks of
 * the heaviest target are interleaved instead of bursting.
 *
 * The schedule is a pure function of the configuration. Which slot a lead takes is decided
 * by a global cursor kept in Postgres (see ADR-0003), so no process memory is involved.
 */

export interface WeightedTarget<Id> {
  readonly id: Id;
  readonly weight: number;
}

export class InvalidWeightsError extends Error {
  override readonly name = 'InvalidWeightsError';
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Builds the schedule. Ties are broken by input order, so callers must pass targets in a
 * stable order (e.g. sorted by slug) to get a reproducible schedule.
 */
export function buildWeightedSchedule<Id>(targets: readonly WeightedTarget<Id>[]): Id[] {
  if (targets.length === 0) {
    throw new InvalidWeightsError('at least one target is required');
  }
  for (const target of targets) {
    if (!Number.isSafeInteger(target.weight) || target.weight <= 0) {
      throw new InvalidWeightsError(`weight must be a positive integer, got ${target.weight}`);
    }
  }

  const divisor = targets.reduce((acc, t) => gcd(acc, t.weight), 0);
  const weights = targets.map((t) => t.weight / divisor);
  const total = weights.reduce((acc, w) => acc + w, 0);
  const current = weights.map(() => 0);
  const schedule: Id[] = [];

  for (let step = 0; step < total; step++) {
    let best = 0;
    for (let i = 0; i < weights.length; i++) {
      current[i] = (current[i] ?? 0) + (weights[i] ?? 0);
      if ((current[i] ?? 0) > (current[best] ?? 0)) best = i;
    }
    current[best] = (current[best] ?? 0) - total;
    // biome-ignore lint/style/noNonNullAssertion: `best` is always a valid index of `targets`
    schedule.push(targets[best]!.id);
  }

  return schedule;
}

/**
 * Maps a 1-based global cursor to a schedule slot. Cursor n and n + schedule.length
 * always land on the same slot.
 */
export function pickSlot<Id>(schedule: readonly Id[], cursor: bigint): Id {
  if (schedule.length === 0) {
    throw new InvalidWeightsError('schedule is empty');
  }
  if (cursor < 1n) {
    throw new RangeError(`cursor must be >= 1, got ${cursor}`);
  }
  const index = Number((cursor - 1n) % BigInt(schedule.length));
  // biome-ignore lint/style/noNonNullAssertion: index is within bounds by construction
  return schedule[index]!;
}
