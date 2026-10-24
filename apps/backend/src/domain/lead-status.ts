import type { LeadStatus } from '@elevate/contracts';

/**
 * Transições de status permitidas para um lead (ADR-0005).
 * `sale` só pode ser revertido por `refund`; `refund` e `invalid` são terminais.
 * `no_answer` e `callback` podem se repetir: cada um é uma nova tentativa de contato.
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
  /** Quando o status atual passou a valer (segundo o evento que o definiu). */
  readonly currentChangedAt: Date;
  readonly next: LeadStatus;
  /** Quando o evento recebido aconteceu na origem, não quando nós o recebemos. */
  readonly occurredAt: Date;
}

/**
 * Decide se um evento de status recebido altera o lead.
 *
 * 1. Ordenação: um evento que aconteceu no mesmo instante ou antes do status atual está
 *    obsoleto (stale). Um `contacted` das 11:00 que chega depois de um `sale` das 12:00 nunca
 *    sobrescreve a venda.
 * 2. Máquina de estados: mesmo um evento mais novo é rejeitado se a transição não for permitida.
 *
 * Eventos rejeitados continuam sendo gravados por quem chama, para auditoria.
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
