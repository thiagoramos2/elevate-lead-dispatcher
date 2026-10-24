import { describe, expect, it } from 'vitest';
import { canonicalJson, deriveIdempotency } from '../../src/domain/idempotency.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: null }] } })).toBe(
      '{"a":{"c":[2,{"y":null,"z":1}]},"b":1}',
    );
  });
});

describe('deriveIdempotency', () => {
  const payload = { name: 'João', email: 'joao@email.com', utm: { source: 'fb', medium: 'cpc' } };
  const morning = new Date('2026-10-24T09:00:00Z');

  it('gives the same identity regardless of key order', () => {
    const reordered = {
      utm: { medium: 'cpc', source: 'fb' },
      email: 'joao@email.com',
      name: 'João',
    };
    expect(deriveIdempotency(reordered, undefined, morning)).toEqual(
      deriveIdempotency(payload, undefined, morning),
    );
  });

  it('derives the key from the payload and the UTC day when the client sends none', () => {
    const identity = deriveIdempotency(payload, undefined, morning);
    expect(identity.key).toBe(`payload:2026-10-24:${identity.requestHash}`);
    expect(identity.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats an identical payload on the same UTC day as the same request', () => {
    const evening = new Date('2026-10-24T23:59:59Z');
    expect(deriveIdempotency(payload, undefined, evening).key).toBe(
      deriveIdempotency(payload, undefined, morning).key,
    );
  });

  it('treats an identical payload on another day as a new request', () => {
    const nextDay = new Date('2026-10-25T00:00:00Z');
    const today = deriveIdempotency(payload, undefined, morning);
    const tomorrow = deriveIdempotency(payload, undefined, nextDay);
    expect(tomorrow.key).not.toBe(today.key);
    expect(tomorrow.requestHash).toBe(today.requestHash);
  });

  it('uses the client key when present, without expiry, keeping the hash for conflicts', () => {
    const a = deriveIdempotency(payload, 'order-123', morning);
    const b = deriveIdempotency({ ...payload, name: 'Maria' }, 'order-123', new Date('2027-01-01'));
    expect(a.key).toBe('client:order-123');
    expect(b.key).toBe(a.key);
    expect(b.requestHash).not.toBe(a.requestHash);
  });

  it('never lets a client key collide with a payload-derived key', () => {
    const derived = deriveIdempotency(payload, undefined, morning);
    const spoofed = deriveIdempotency(payload, derived.key.replace(/^payload:/, ''), morning);
    expect(spoofed.key).not.toBe(derived.key);
  });
});
