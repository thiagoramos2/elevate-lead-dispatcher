import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/** JSON com as chaves dos objetos ordenadas recursivamente e os membros `undefined` removidos. */
export function canonicalJson(value: Json | undefined): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const members = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${members.join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface IdempotencyIdentity {
  /** Chave única gravada no lead. Tem prefixo para chaves do cliente e hashes de payload nunca colidirem. */
  readonly key: string;
  /** Hash do payload normalizado, usado para detectar uma chave reutilizada com outro corpo. */
  readonly requestHash: string;
}

/** Dia do calendário em UTC, ex.: "2026-10-24". */
function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Deriva a identidade de idempotência de uma requisição de lead (ADR-0004).
 * `payload` precisa ser o payload já validado e normalizado, para que retries com diferenças
 * triviais (ordem das chaves, maiúsculas no e-mail, espaços) gerem a mesma identidade.
 *
 * - Chave do cliente: quem chama afirma "é a mesma requisição", então ela nunca expira.
 * - Chave derivada do payload: vale dentro do dia UTC de `receivedAt`. Retries de rede
 *   (segundos a minutos) viram um único lead; a mesma pessoa enviando de novo em outro dia gera
 *   um lead novo. Um retry que cruze a meia-noite UTC pode criar um segundo lead: caso de borda
 *   documentado e muito improvável.
 */
export function deriveIdempotency(
  payload: { [key: string]: Json | undefined },
  clientKey: string | undefined,
  receivedAt: Date,
): IdempotencyIdentity {
  const requestHash = sha256Hex(canonicalJson(payload));
  return {
    key:
      clientKey === undefined
        ? `payload:${utcDay(receivedAt)}:${requestHash}`
        : `client:${clientKey}`,
    requestHash,
  };
}
