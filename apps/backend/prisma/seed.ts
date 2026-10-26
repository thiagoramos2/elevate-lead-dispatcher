/**
 * Dados de demonstração para a avaliação local. Idempotente: seguro rodar a cada subida do container.
 * Os nomes de produto são fictícios; as senhas são valores de demonstração vindos do ambiente.
 */

import { createDatabase } from '../src/infra/prisma.js';
import { hashPassword } from '../src/modules/auth/password.js';

const DEMO_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Elevate-Admin-2026';
const DEMO_OPERATOR_PASSWORD = process.env.SEED_OPERATOR_PASSWORD ?? 'Elevate-Operator-2026';

const catalog = [
  { slug: 'nutralean', name: 'NutraLean', funnels: ['vsl-01', 'vsl-02', 'quiz-01'] },
  { slug: 'glucoshield', name: 'GlucoShield', funnels: ['vsl-01', 'tsl-01'] },
  { slug: 'prostavive', name: 'ProstaVive', funnels: ['vsl-01'] },
] as const;

const callCenters = [
  { slug: 'callcenter-a', name: 'Call Center A', weight: 50 },
  { slug: 'callcenter-b', name: 'Call Center B', weight: 30 },
  { slug: 'callcenter-c', name: 'Call Center C', weight: 20 },
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDatabase({ url, poolMax: 2 });

  try {
    for (const product of catalog) {
      const { id: productId } = await db.product.upsert({
        where: { slug: product.slug },
        create: { slug: product.slug, name: product.name },
        update: {},
      });
      for (const funnel of product.funnels) {
        await db.funnel.upsert({
          where: { productId_slug: { productId, slug: funnel } },
          create: { productId, slug: funnel, name: funnel.toUpperCase() },
          update: {},
        });
      }
    }

    const centerIds = new Map<string, string>();
    for (const center of callCenters) {
      const { id } = await db.callCenter.upsert({
        where: { slug: center.slug },
        create: center,
        update: {},
      });
      centerIds.set(center.slug, id);
    }

    await db.user.upsert({
      where: { email: 'admin@elevate.local' },
      create: {
        email: 'admin@elevate.local',
        passwordHash: await hashPassword(DEMO_ADMIN_PASSWORD),
        role: 'admin',
      },
      update: {},
    });

    for (const center of callCenters) {
      const email = `operator.${center.slug.replace('callcenter-', '')}@elevate.local`;
      await db.user.upsert({
        where: { email },
        create: {
          email,
          passwordHash: await hashPassword(DEMO_OPERATOR_PASSWORD),
          role: 'operator',
          callCenterId: centerIds.get(center.slug) ?? null,
        },
        update: {},
      });
    }

    console.log('Seed complete: 3 products, 6 funnels, 3 call centers, 4 users.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
