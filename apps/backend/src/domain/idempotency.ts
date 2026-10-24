import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/** JSON with object keys sorted recursively and `undefined` members dropped. */
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
  /** Unique key stored on the lead. Prefixed so client keys and payload hashes never collide. */
  readonly key: string;
  /** Hash of the normalized payload, used to detect a reused key with a different body. */
  readonly requestHash: string;
}

/**
 * Derives the idempotency identity of a lead request (ADR-0004).
 * `payload` must be the validated, normalized payload, so that trivially different
 * retries (key order, e-mail casing, whitespace) map to the same identity.
 */
export function deriveIdempotency(
  payload: { [key: string]: Json | undefined },
  clientKey: string | undefined,
): IdempotencyIdentity {
  const requestHash = sha256Hex(canonicalJson(payload));
  return {
    key: clientKey === undefined ? `payload:${requestHash}` : `client:${clientKey}`,
    requestHash,
  };
}
