import type { LeadStatus } from '@elevate/contracts';

/**
 * Allowed lead status transitions (ADR-0005).
 * `sale` can only be reversed by `refund`; `refund` and `invalid` are terminal.
 * `no_answer` and `callback` may repeat: each one is a new contact attempt.
 */
export const STATUS_TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  new: ['contacted', 'no_answer', 'callback', 'qualified', 'sale', 'invalid'],
  contacted: ['no_answer', 'callback', 'qualified', 'sale', 'invalid'],
  no_answer: ['contacted', 'no_answer', 'callback', 'qualified', 'sale', 'invalid'],
  callback: ['contacted', 'no_answer', 'callback', 'qualified', 'sale', 'invalid'],
  qualified: ['contacted', 'no_answer', 'callback', 'sale', 'invalid'],
  sale: ['refund'],
  refund: [],
  invalid: [],
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export type StatusChangeRejection = 'stale' | 'invalid_transition';

export type StatusChangeDecision =
  | { readonly apply: true }
  | { readonly apply: false; readonly reason: StatusChangeRejection };

export interface StatusChangeRequest {
  readonly current: LeadStatus;
  /** When the current status took effect (from the event that set it). */
  readonly currentChangedAt: Date;
  readonly next: LeadStatus;
  /** When the incoming event happened at the source, not when we received it. */
  readonly occurredAt: Date;
}

/**
 * Decides whether an incoming status event changes the lead.
 *
 * 1. Ordering: an event that happened at or before the current status is stale.
 *    A `contacted` from 11:00 arriving after a `sale` from 12:00 never overwrites the sale.
 * 2. State machine: a newer event is still rejected if the transition is not allowed.
 *
 * Rejected events are still recorded by the caller for auditing.
 */
export function decideStatusChange(request: StatusChangeRequest): StatusChangeDecision {
  if (request.occurredAt.getTime() <= request.currentChangedAt.getTime()) {
    return { apply: false, reason: 'stale' };
  }
  if (!canTransition(request.current, request.next)) {
    return { apply: false, reason: 'invalid_transition' };
  }
  return { apply: true };
}
