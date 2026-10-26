import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Database } from '../../src/infra/prisma.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { distributeLead } from '../../src/modules/dispatch/distribution.service.js';
import { buildTestApp, validLead } from './setup/app.js';
import {
  connectTestDatabase,
  type Fixtures,
  resetDatabase,
  seedFixtures,
} from './setup/database.js';

const PASSWORD = 'Correct#Horse9';
const ORIGIN = 'http://localhost:3000';

describe('authentication, authorization and dashboard API', () => {
  const db: Database = connectTestDatabase();
  let app: App;
  let fx: Fixtures;
  let passwordHash: string;
  /** Leads por call center, na ordem do escalonamento: A B C A A B A C B A. */
  let leadsByCenter: { a: string[]; b: string[]; c: string[] };

  const login = async (email: string, password = PASSWORD) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
      headers: { origin: ORIGIN },
    });
    const cookie = response.cookies.find((c) => c.name === 'eld_session');
    return { response, cookie: cookie ? `eld_session=${cookie.value}` : undefined };
  };

  const as = async (email: string) => {
    const { cookie } = await login(email);
    if (!cookie) throw new Error(`login failed for ${email}`);
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
      send: (method: 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
        app.inject({ method, url, payload: payload ?? {}, headers: { cookie, origin: ORIGIN } }),
    };
  };

  beforeAll(async () => {
    app = await buildTestApp(db);
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    fx = await seedFixtures(db);
    await db.user.createMany({
      data: [
        { email: 'admin@test.local', passwordHash, role: 'admin' },
        {
          email: 'op.a@test.local',
          passwordHash,
          role: 'operator',
          callCenterId: fx.callCenters.a,
        },
        {
          email: 'op.b@test.local',
          passwordHash,
          role: 'operator',
          callCenterId: fx.callCenters.b,
        },
      ],
    });
    leadsByCenter = { a: [], b: [], c: [] };
    for (let i = 0; i < 10; i++) {
      const { lead_id } = (
        await app.inject({
          method: 'POST',
          url: '/api/leads',
          payload: validLead({ source: i < 5 ? 'facebook' : 'google' }),
        })
      ).json();
      const outcome = await distributeLead(db, lead_id);
      if (outcome.kind !== 'distributed') throw new Error('not distributed');
      const key =
        outcome.callCenterId === fx.callCenters.a
          ? 'a'
          : outcome.callCenterId === fx.callCenters.b
            ? 'b'
            : 'c';
      leadsByCenter[key].push(lead_id);
    }
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe('login and session', () => {
    it('sets an HttpOnly, SameSite=Strict session cookie and never exposes the password hash', async () => {
      const { response } = await login('op.a@test.local');
      expect(response.statusCode).toBe(200);
      const cookie = response.cookies.find((c) => c.name === 'eld_session');
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
      expect(response.json().user).toEqual({
        id: expect.any(String),
        email: 'op.a@test.local',
        role: 'operator',
        callCenterId: fx.callCenters.a,
        callCenterName: 'Call Center A',
      });
      expect(response.body).not.toMatch(/argon2|passwordHash|password_hash/);
      // No banco fica só o hash do token, nunca o token.
      const session = await db.session.findFirstOrThrow();
      expect(session.tokenHash).not.toBe(cookie?.value);
    });

    it('answers wrong password and unknown e-mail identically (no user enumeration)', async () => {
      const wrong = await login('op.a@test.local', 'nope');
      const unknown = await login('ghost@test.local', 'nope');
      expect(wrong.response.statusCode).toBe(401);
      expect(unknown.response.statusCode).toBe(401);
      expect(wrong.response.json()).toEqual(unknown.response.json());
    });

    it('locks the account after 5 failures, even for the right password', async () => {
      for (let i = 0; i < 5; i++) await login('op.a@test.local', 'wrong');
      const right = await login('op.a@test.local');
      expect(right.response.statusCode).toBe(401);
      const user = await db.user.findUniqueOrThrow({ where: { email: 'op.a@test.local' } });
      expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    });

    it('resolves the current user and invalidates the session on logout', async () => {
      const { cookie } = await login('admin@test.local');
      const headers = { cookie: cookie ?? '', origin: ORIGIN };
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(
        200,
      );

      const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
      expect(out.statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(
        401,
      );
      expect(await db.session.count()).toBe(0);
    });

    it('rejects an expired session', async () => {
      const { cookie } = await login('admin@test.local');
      await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: cookie ?? '' },
      });
      expect(me.statusCode).toBe(401);
    });

    it('rate limits login attempts per IP', async () => {
      const limited = await buildTestApp(db, { RATE_LIMIT_LOGIN_PER_MINUTE: '3' });
      try {
        const attempt = () =>
          limited.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: 'x@test.local', password: 'x' },
          });
        const statuses = [];
        for (let i = 0; i < 4; i++) statuses.push((await attempt()).statusCode);
        expect(statuses).toEqual([401, 401, 401, 429]);
        expect((await attempt()).json().error.code).toBe('RATE_LIMITED');
      } finally {
        await limited.close();
      }
    });
  });

  describe('authorization is enforced by the backend', () => {
    it('requires a session for every dashboard and admin route', async () => {
      for (const url of [
        '/api/leads',
        '/api/leads/metrics',
        '/api/catalog',
        '/api/admin/dispatcher',
      ]) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
    });

    it('limits an operator to the leads of their call center, whatever filter is sent', async () => {
      const opA = await as('op.a@test.local');
      const own = (await opA.get('/api/leads?limit=100')).json();
      expect(own.items.map((l: { id: string }) => l.id).sort()).toEqual(
        [...leadsByCenter.a].sort(),
      );

      // Tentar ver o call center B pela query string não vaza nada.
      const forged = (await opA.get(`/api/leads?callCenter=${fx.callCenters.b}`)).json();
      expect(forged.items).toEqual([]);
    });

    it('answers 404 when an operator opens or updates a lead of another call center', async () => {
      const opA = await as('op.a@test.local');
      const foreign = leadsByCenter.b[0];
      expect((await opA.get(`/api/leads/${foreign}`)).statusCode).toBe(404);
      const update = await opA.send('PATCH', `/api/leads/${foreign}/status`, { status: 'sale' });
      expect(update.statusCode).toBe(404);
      expect((await db.lead.findUniqueOrThrow({ where: { id: foreign } })).status).toBe('new');
    });

    it('forbids operators from admin routes even through direct API calls', async () => {
      const opA = await as('op.a@test.local');
      expect((await opA.get('/api/admin/dispatcher')).statusCode).toBe(403);
      const put = await opA.send('PUT', '/api/admin/dispatcher', {
        callCenters: [{ id: fx.callCenters.a, weight: 100, active: true }],
      });
      expect(put.statusCode).toBe(403);
      expect(
        (await opA.send('POST', `/api/admin/leads/${leadsByCenter.a[0]}/redistribute`)).statusCode,
      ).toBe(403);
      expect(
        (await db.callCenter.findUniqueOrThrow({ where: { id: fx.callCenters.a } })).weight,
      ).toBe(50);
    });

    it('rejects a state-changing request carrying the session cookie from another origin (CSRF)', async () => {
      const { cookie } = await login('op.a@test.local');
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/leads/${leadsByCenter.a[0]}/status`,
        payload: { status: 'sale' },
        headers: { cookie: cookie ?? '', origin: 'https://evil.example' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CSRF_REJECTED');
    });
  });

  describe('operator workflow', () => {
    it('updates a lead status, recording who did it in the history', async () => {
      const opA = await as('op.a@test.local');
      const leadId = leadsByCenter.a[0];
      const response = await opA.send('PATCH', `/api/leads/${leadId}/status`, {
        status: 'contacted',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, status: 'contacted' });

      const detail = (await opA.get(`/api/leads/${leadId}`)).json();
      expect(detail.status).toBe('contacted');
      expect(detail.events.at(-1)).toMatchObject({
        origin: 'operator',
        fromStatus: 'new',
        toStatus: 'contacted',
        applied: true,
        actorEmail: 'op.a@test.local',
      });
    });

    it('refuses a forbidden transition with 422 and still records the attempt', async () => {
      const opA = await as('op.a@test.local');
      const leadId = leadsByCenter.a[0];
      await opA.send('PATCH', `/api/leads/${leadId}/status`, { status: 'sale' });
      const back = await opA.send('PATCH', `/api/leads/${leadId}/status`, { status: 'contacted' });
      expect(back.statusCode).toBe(422);
      expect(back.json().error.code).toBe('INVALID_TRANSITION');
      const events = await db.leadEvent.findMany({
        where: { leadId, origin: 'operator' },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      expect(events.map((e) => e.applied)).toEqual([true, false]);
    });
  });

  describe('admin dashboard API', () => {
    it('lists every lead with keyset pagination and no overlap between pages', async () => {
      const admin = await as('admin@test.local');
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: { id: string }[]; nextCursor: string | null } = (
          await admin.get(
            `/api/leads?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          )
        ).json();
        seen.push(...page.items.map((l: { id: string }) => l.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
    });

    it('rejects a tampered cursor', async () => {
      const admin = await as('admin@test.local');
      expect((await admin.get('/api/leads?cursor=not-a-cursor')).statusCode).toBe(400);
    });

    it('filters by status, source, call center, product and period', async () => {
      const admin = await as('admin@test.local');
      await admin.send('PATCH', `/api/leads/${leadsByCenter.c[0]}/status`, { status: 'sale' });

      const count = async (query: string) =>
        (await admin.get(`/api/leads?limit=100&${query}`)).json().items.length;
      expect(await count('status=sale')).toBe(1);
      expect(await count('source=facebook')).toBe(5);
      expect(await count(`callCenter=${fx.callCenters.b}`)).toBe(3);
      expect(await count(`product=${fx.products.nutralean}`)).toBe(10);
      expect(await count(`product=${fx.products.glucoshield}`)).toBe(0);
      expect(await count('distribution=distributed')).toBe(10);
      expect(await count('distribution=failed')).toBe(0);
      const future = new Date(Date.now() + 3600_000).toISOString();
      expect(await count(`from=${encodeURIComponent(future)}`)).toBe(0);
    });

    it('computes the metrics with the same filters and scope as the list', async () => {
      const admin = await as('admin@test.local');
      await admin.send('PATCH', `/api/leads/${leadsByCenter.a[0]}/status`, { status: 'sale' });
      await admin.send('PATCH', `/api/leads/${leadsByCenter.b[0]}/status`, { status: 'contacted' });

      expect((await admin.get('/api/leads/metrics')).json()).toEqual({
        total: 10,
        today: 10,
        distributed: 10,
        pending: 0,
        awaitingContact: 8,
        failed: 0,
        sales: 1,
        conversionRate: 0.1,
      });

      const opA = await as('op.a@test.local');
      expect((await opA.get('/api/leads/metrics')).json()).toMatchObject({ total: 5, sales: 1 });
    });

    it('changes dispatcher weights atomically and resets the cursor', async () => {
      const admin = await as('admin@test.local');
      const response = await admin.send('PUT', '/api/admin/dispatcher', {
        callCenters: [
          { id: fx.callCenters.a, weight: 70, active: true },
          { id: fx.callCenters.c, weight: 20, active: false },
        ],
      });
      expect(response.statusCode).toBe(200);
      const config = response.json();
      expect(config.configVersion).toBe(2);
      const a = config.callCenters.find((c: { id: string }) => c.id === fx.callCenters.a);
      expect(a).toMatchObject({ weight: 70, active: true, share: 0.7, distributedTotal: 5 });
      expect((await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } })).cursor).toBe(0n);
    });

    it('refuses a configuration with no active call center and changes nothing', async () => {
      const admin = await as('admin@test.local');
      const response = await admin.send('PUT', '/api/admin/dispatcher', {
        callCenters: Object.values(fx.callCenters).map((id) => ({ id, weight: 10, active: false })),
      });
      expect(response.statusCode).toBe(422);
      expect(await db.callCenter.count({ where: { active: true } })).toBe(3);
      expect((await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } })).configVersion).toBe(
        1,
      );
    });

    it('redistributes a failed lead through the outbox, and only failed leads', async () => {
      const admin = await as('admin@test.local');
      const failed = (
        await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() })
      ).json().lead_id;
      await db.lead.update({ where: { id: failed }, data: { distributionStatus: 'failed' } });
      await db.outboxEvent.deleteMany();

      const response = await admin.send('POST', `/api/admin/leads/${failed}/redistribute`);
      expect(response.statusCode).toBe(202);
      expect((await db.lead.findUniqueOrThrow({ where: { id: failed } })).distributionStatus).toBe(
        'pending',
      );
      expect(await db.outboxEvent.count({ where: { aggregateId: failed } })).toBe(1);

      const distributed = await admin.send(
        'POST',
        `/api/admin/leads/${leadsByCenter.a[0]}/redistribute`,
      );
      expect(distributed.statusCode).toBe(409);
    });
  });
});
