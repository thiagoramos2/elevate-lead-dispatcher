import { createLeadSchema, idempotencyKeySchema } from '@elevate/contracts';
import { describe, expect, it } from 'vitest';

const valid = {
  name: 'João Silva',
  email: 'joao@email.com',
  phone: '+5511999999999',
  product: 'nutralean',
  funnel: 'vsl-01',
  source: 'facebook',
  campaign: 'campaign-123',
  affiliate_id: '999',
  utm: { source: 'facebook', medium: 'cpc', campaign: 'campaign-123', content: 'ad-01' },
};

const errorPaths = (input: unknown) => {
  const result = createLeadSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('createLeadSchema', () => {
  it('accepts the payload from the test statement', () => {
    expect(createLeadSchema.safeParse(valid).success).toBe(true);
  });

  it('normalizes e-mail casing, whitespace and phone formatting', () => {
    const lead = createLeadSchema.parse({
      ...valid,
      name: '  João Silva  ',
      email: ' Joao@Email.COM ',
      phone: '+55 (11) 99999-9999',
      product: 'NutraLean',
    });
    expect(lead.name).toBe('João Silva');
    expect(lead.email).toBe('joao@email.com');
    expect(lead.phone).toBe('+5511999999999');
    expect(lead.product).toBe('nutralean');
  });

  it('accepts a minimal payload without tracking data', () => {
    const { source, campaign, affiliate_id, utm, ...minimal } = valid;
    expect(createLeadSchema.safeParse(minimal).success).toBe(true);
  });

  it.each(['name', 'email', 'phone', 'product', 'funnel'])('requires %s', (field) => {
    const { [field as keyof typeof valid]: _omitted, ...rest } = valid;
    expect(errorPaths(rest)).toContain(field);
  });

  it.each([
    ['name', 'J'],
    ['email', 'not-an-email'],
    ['phone', '11999999999'],
    ['phone', '+55119'],
    ['phone', '+5511abc999999'],
    ['product', 'nutra lean!'],
    ['funnel', ''],
    ['affiliate_id', '9 9 9'],
  ])('rejects invalid %s %j', (field, value) => {
    expect(errorPaths({ ...valid, [field]: value })).toContain(field);
  });

  it.each([
    ['name', 123],
    ['phone', 5511999999999],
    ['affiliate_id', 999],
    ['utm', 'facebook'],
  ])('rejects wrong type for %s', (field, value) => {
    expect(errorPaths({ ...valid, [field]: value })).toContain(field);
  });

  it('rejects unknown UTM keys', () => {
    expect(errorPaths({ ...valid, utm: { ...valid.utm, sourc: 'typo' } })).toContain('utm');
  });

  it('rejects control characters in tracking values', () => {
    expect(errorPaths({ ...valid, campaign: 'abc\u0000def' })).toContain('campaign');
  });

  it('strips unknown top-level keys instead of persisting them', () => {
    const lead = createLeadSchema.parse({ ...valid, honeypot: 'x' });
    expect(lead).not.toHaveProperty('honeypot');
  });
});

describe('idempotencyKeySchema', () => {
  it('accepts printable keys between 8 and 255 characters', () => {
    expect(idempotencyKeySchema.safeParse('order-123-abc').success).toBe(true);
  });

  it.each(['short', 'has space inside', 'a'.repeat(256)])('rejects %j', (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});
