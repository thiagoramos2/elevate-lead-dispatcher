import { describe, expect, it } from 'vitest';
import {
  buildWeightedSchedule,
  InvalidWeightsError,
  pickSlot,
} from '../../src/domain/weighted-schedule.js';

const count = <T>(items: readonly T[]) =>
  items.reduce((acc, item) => acc.set(item, (acc.get(item) ?? 0) + 1), new Map<T, number>());

describe('buildWeightedSchedule', () => {
  it('produces the interleaved smooth WRR schedule for 50/30/20', () => {
    const schedule = buildWeightedSchedule([
      { id: 'A', weight: 50 },
      { id: 'B', weight: 30 },
      { id: 'C', weight: 20 },
    ]);
    expect(schedule.join(' ')).toBe('A B C A A B A C B A');
  });

  it('reduces weights by their GCD so the cycle stays short', () => {
    expect(
      buildWeightedSchedule([
        { id: 'A', weight: 50 },
        { id: 'B', weight: 50 },
      ]),
    ).toEqual(['A', 'B']);
  });

  it('respects arbitrary weights exactly within one cycle', () => {
    const schedule = buildWeightedSchedule([
      { id: 'A', weight: 7 },
      { id: 'B', weight: 3 },
      { id: 'C', weight: 1 },
    ]);
    expect(schedule).toHaveLength(11);
    expect(count(schedule)).toEqual(
      new Map([
        ['A', 7],
        ['B', 3],
        ['C', 1],
      ]),
    );
  });

  it('never bursts the heaviest target beyond what its weight requires', () => {
    const schedule = buildWeightedSchedule([
      { id: 'A', weight: 5 },
      { id: 'B', weight: 3 },
      { id: 'C', weight: 2 },
    ]);
    const doubled = [...schedule, ...schedule];
    let longestRun = 0;
    let run = 0;
    for (let i = 0; i < doubled.length; i++) {
      run = doubled[i] === doubled[i - 1] ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeLessThanOrEqual(2);
  });

  it('handles a single target', () => {
    expect(buildWeightedSchedule([{ id: 'A', weight: 30 }])).toEqual(['A']);
  });

  it.each([
    [[]],
    [[{ id: 'A', weight: 0 }]],
    [[{ id: 'A', weight: -1 }]],
    [[{ id: 'A', weight: 1.5 }]],
  ])('rejects invalid configuration %j', (targets) => {
    expect(() => buildWeightedSchedule(targets)).toThrow(InvalidWeightsError);
  });
});

describe('pickSlot', () => {
  const schedule = buildWeightedSchedule([
    { id: 'A', weight: 5 },
    { id: 'B', weight: 3 },
    { id: 'C', weight: 2 },
  ]);

  it('maps a 1-based cursor onto the schedule and wraps around', () => {
    expect(pickSlot(schedule, 1n)).toBe('A');
    expect(pickSlot(schedule, 2n)).toBe('B');
    expect(pickSlot(schedule, 3n)).toBe('C');
    expect(pickSlot(schedule, 11n)).toBe('A');
    expect(pickSlot(schedule, 12n)).toBe('B');
  });

  it('distributes any N consecutive cursors within 1 lead of the ideal share', () => {
    for (const start of [1n, 4n, 7n]) {
      const picks = Array.from({ length: 100 }, (_, i) => pickSlot(schedule, start + BigInt(i)));
      const counts = count(picks);
      expect(counts.get('A')).toBe(50);
      expect(counts.get('B')).toBe(30);
      expect(counts.get('C')).toBe(20);
    }
    const picks = Array.from({ length: 37 }, (_, i) => pickSlot(schedule, BigInt(i + 1)));
    const counts = count(picks);
    expect(Math.abs((counts.get('A') ?? 0) - 37 * 0.5)).toBeLessThanOrEqual(1);
    expect(Math.abs((counts.get('B') ?? 0) - 37 * 0.3)).toBeLessThanOrEqual(1);
    expect(Math.abs((counts.get('C') ?? 0) - 37 * 0.2)).toBeLessThanOrEqual(1);
  });

  it('supports cursors beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 2n ** 62n;
    expect(['A', 'B', 'C']).toContain(pickSlot(schedule, huge));
  });

  it('rejects a cursor below 1', () => {
    expect(() => pickSlot(schedule, 0n)).toThrow(RangeError);
  });
});
