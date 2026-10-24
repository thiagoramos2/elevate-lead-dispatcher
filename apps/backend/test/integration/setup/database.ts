import { inject } from 'vitest';
import { createDatabase, type Database } from '../../../src/infra/prisma.js';

export function connectTestDatabase(poolMax = 20): Database {
  return createDatabase({ url: inject('databaseUrl'), poolMax });
}

/**
 * Esvazia todas as tabelas de dados e volta o cursor do dispatcher para zero. O schema e a linha
 * estrutural do dispatcher_state são mantidos.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.$executeRaw`
    TRUNCATE lead_events, distributions, outbox_events, leads, affiliates, sessions, users,
             funnels, products, call_centers
    RESTART IDENTITY CASCADE`;
  await db.$executeRaw`UPDATE dispatcher_state SET cursor = 0, config_version = 1`;
}

export interface Fixtures {
  readonly products: { nutralean: string; glucoshield: string };
  readonly funnels: { nutraleanVsl: string; glucoshieldVsl: string };
  readonly callCenters: { a: string; b: string; c: string };
}

/** Catálogo igual ao do enunciado: call centers A/B/C com pesos 50/30/20. */
export async function seedFixtures(db: Database): Promise<Fixtures> {
  const nutralean = await db.product.create({ data: { slug: 'nutralean', name: 'NutraLean' } });
  const glucoshield = await db.product.create({
    data: { slug: 'glucoshield', name: 'GlucoShield' },
  });
  const nutraleanVsl = await db.funnel.create({
    data: { productId: nutralean.id, slug: 'vsl-01', name: 'VSL 01' },
  });
  const glucoshieldVsl = await db.funnel.create({
    data: { productId: glucoshield.id, slug: 'vsl-01', name: 'VSL 01' },
  });
  const [a, b, c] = await Promise.all(
    [
      { slug: 'callcenter-a', name: 'Call Center A', weight: 50 },
      { slug: 'callcenter-b', name: 'Call Center B', weight: 30 },
      { slug: 'callcenter-c', name: 'Call Center C', weight: 20 },
    ].map((data) => db.callCenter.create({ data })),
  );
  if (!a || !b || !c) throw new Error('call center fixtures not created');

  return {
    products: { nutralean: nutralean.id, glucoshield: glucoshield.id },
    funnels: { nutraleanVsl: nutraleanVsl.id, glucoshieldVsl: glucoshieldVsl.id },
    callCenters: { a: a.id, b: b.id, c: c.id },
  };
}
