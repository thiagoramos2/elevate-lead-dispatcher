import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../../src/modules/webhooks/signature.js';

const secret = 'test-secret-a-0123456789abcdef0123456789';
const body = '{"lead_id":"8f3c7c2e-5b1a-4d0e-9a67-2f4c1b7e9d10","status":"contacted"}';
const now = 1_792_800_000;

describe('verifySignature', () => {
  it('accepts a signature made with the same secret, body and a fresh timestamp', () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature({ secret, header, rawBody: body, nowSeconds: now + 10 })).toBe('valid');
  });

  it('rejects a tampered body', () => {
    const header = signPayload(secret, body, now);
    const tampered = body.replace('contacted', 'sale');
    expect(verifySignature({ secret, header, rawBody: tampered, nowSeconds: now })).toBe(
      'mismatch',
    );
  });

  it('rejects a signature made with another secret', () => {
    const header = signPayload('another-secret-0123456789abcdef01234567', body, now);
    expect(verifySignature({ secret, header, rawBody: body, nowSeconds: now })).toBe('mismatch');
  });

  it('rejects a body that was re-serialized (only the raw body is signed)', () => {
    const header = signPayload(secret, body, now);
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifySignature({ secret, header, rawBody: reserialized, nowSeconds: now })).toBe(
      'mismatch',
    );
  });

  it.each([
    ['too old', now - 301],
    ['too far in the future', now + 301],
  ])('rejects a timestamp %s (replay window)', (_label, signedAt) => {
    const header = signPayload(secret, body, signedAt);
    expect(verifySignature({ secret, header, rawBody: body, nowSeconds: now })).toBe('expired');
  });

  it('rejects a timestamp moved inside the window without re-signing', () => {
    const header = signPayload(secret, body, now - 1000).replace(`t=${now - 1000}`, `t=${now}`);
    expect(verifySignature({ secret, header, rawBody: body, nowSeconds: now })).toBe('mismatch');
  });

  it.each([
    [undefined],
    [''],
    ['v1=abc'],
    [`t=${now}`],
    [`t=abc,v1=${'0'.repeat(64)}`],
    [`t=${now},v1=xyz`],
    [`t=${now},v1=${'0'.repeat(63)}`],
  ])('rejects a malformed header %j', (header) => {
    expect(verifySignature({ secret, header, rawBody: body, nowSeconds: now })).toBe('malformed');
  });
});
