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

  it('gives the same identity regardless of key order', () => {
    const reordered = {
      utm: { medium: 'cpc', source: 'fb' },
      email: 'joao@email.com',
      name: 'João',
    };
    expect(deriveIdempotency(reordered, undefined)).toEqual(deriveIdempotency(payload, undefined));
  });

  it('derives the key from the payload when the client sends none', () => {
    const identity = deriveIdempotency(payload, undefined);
    expect(identity.key).toBe(`payload:${identity.requestHash}`);
    expect(identity.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the client key when present, keeping the payload hash for conflict detection', () => {
    const a = deriveIdempotency(payload, 'order-123');
    const b = deriveIdempotency({ ...payload, name: 'Maria' }, 'order-123');
    expect(a.key).toBe('client:order-123');
    expect(b.key).toBe(a.key);
    expect(b.requestHash).not.toBe(a.requestHash);
  });

  it('never lets a client key collide with a payload-derived key', () => {
    const derived = deriveIdempotency(payload, undefined);
    const spoofed = deriveIdempotency(payload, derived.requestHash);
    expect(spoofed.key).not.toBe(derived.key);
  });
});
