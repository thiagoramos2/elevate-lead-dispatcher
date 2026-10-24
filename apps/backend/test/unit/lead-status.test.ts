import { LEAD_STATUSES, type LeadStatus } from '@elevate/contracts';
import { describe, expect, it } from 'vitest';
import { canTransition, decideStatusChange } from '../../src/domain/lead-status.js';

const at = (iso: string) => new Date(iso);

describe('canTransition', () => {
  it.each<[LeadStatus, LeadStatus]>([
    ['new', 'contacted'],
    ['contacted', 'qualified'],
    ['qualified', 'sale'],
    ['sale', 'refund'],
    ['no_answer', 'no_answer'],
    ['callback', 'contacted'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[LeadStatus, LeadStatus]>([
    ['sale', 'contacted'],
    ['sale', 'qualified'],
    ['contacted', 'new'],
    ['new', 'refund'],
    ['qualified', 'refund'],
    ['contacted', 'contacted'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('treats refund and invalid as terminal', () => {
    for (const to of LEAD_STATUSES) {
      expect(canTransition('refund', to)).toBe(false);
      expect(canTransition('invalid', to)).toBe(false);
    }
  });

  it('never allows going back to new', () => {
    for (const from of LEAD_STATUSES) {
      expect(canTransition(from, 'new')).toBe(false);
    }
  });
});

describe('decideStatusChange', () => {
  it('applies a newer, allowed event', () => {
    expect(
      decideStatusChange({
        current: 'new',
        currentChangedAt: at('2026-10-08T12:00:00Z'),
        next: 'contacted',
        occurredAt: at('2026-10-08T12:30:00Z'),
      }),
    ).toEqual({ apply: true });
  });

  it('ignores a contacted event that happened before an already applied sale', () => {
    expect(
      decideStatusChange({
        current: 'sale',
        currentChangedAt: at('2026-10-08T12:00:00Z'),
        next: 'contacted',
        occurredAt: at('2026-10-08T11:00:00Z'),
      }),
    ).toEqual({ apply: false, reason: 'stale' });
  });

  it('treats an event with the same timestamp as stale', () => {
    expect(
      decideStatusChange({
        current: 'contacted',
        currentChangedAt: at('2026-10-08T12:00:00Z'),
        next: 'qualified',
        occurredAt: at('2026-10-08T12:00:00Z'),
      }),
    ).toEqual({ apply: false, reason: 'stale' });
  });

  it('rejects a newer event whose transition is not allowed', () => {
    expect(
      decideStatusChange({
        current: 'sale',
        currentChangedAt: at('2026-10-08T12:00:00Z'),
        next: 'contacted',
        occurredAt: at('2026-10-08T13:00:00Z'),
      }),
    ).toEqual({ apply: false, reason: 'invalid_transition' });
  });

  it('allows a refund after a sale', () => {
    expect(
      decideStatusChange({
        current: 'sale',
        currentChangedAt: at('2026-10-08T12:00:00Z'),
        next: 'refund',
        occurredAt: at('2026-10-09T09:00:00Z'),
      }),
    ).toEqual({ apply: true });
  });
});
