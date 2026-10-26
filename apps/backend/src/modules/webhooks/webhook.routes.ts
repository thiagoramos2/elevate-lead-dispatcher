import {
  CALLCENTER_ID_HEADER,
  callCenterWebhookResponseSchema,
  callCenterWebhookSchema,
  errorResponseSchema,
  SIGNATURE_HEADER,
} from '@elevate/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sha256Hex } from '../../domain/idempotency.js';
import { AppError, unprocessable } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import { recordStatusEvent } from '../status/status.service.js';
import { SIGNATURE_TOLERANCE_SECONDS, verifySignature } from './signature.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Corpo bruto da requisição; só existe nas rotas de webhook (assinatura HMAC). */
    rawBody?: string;
  }
}

export interface WebhookRoutesOptions {
  readonly db: Database;
  /** slug do call center → segredo HMAC. */
  readonly secrets: ReadonlyMap<string, string>;
}

const unauthorized = () =>
  new AppError(401, 'INVALID_SIGNATURE', 'Missing or invalid webhook signature');

export const webhookRoutes: FastifyPluginAsyncZod<WebhookRoutesOptions> = async (
  app,
  { db, secrets },
) => {
  // Neste plugin (encapsulado), o JSON é lido como texto para guardar o corpo bruto que foi assinado.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });

  app.post(
    '/api/webhooks/callcenter',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Status update from a call center',
        description:
          'Authenticated with HMAC-SHA256 per call center: X-CallCenter-Id: <slug> and ' +
          'X-Signature: t=<unix seconds>,v1=<hex hmac of "<t>.<raw body>">. ' +
          'Duplicates and out-of-order events are recorded and answered with 200 without changing the lead.',
        headers: z.looseObject({
          [CALLCENTER_ID_HEADER]: z.string().optional(),
          [SIGNATURE_HEADER]: z.string().optional(),
        }),
        body: callCenterWebhookSchema,
        response: {
          200: callCenterWebhookResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
      // Autentica antes de validar o corpo: quem não tem assinatura válida não recebe detalhes de validação.
      preValidation: async (request) => {
        const slug = request.headers[CALLCENTER_ID_HEADER];
        const secret = typeof slug === 'string' ? secrets.get(slug) : undefined;
        if (!secret) throw unauthorized();
        const header = request.headers[SIGNATURE_HEADER];
        const check = verifySignature({
          secret,
          header: typeof header === 'string' ? header : undefined,
          rawBody: request.rawBody ?? '',
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        if (check !== 'valid') {
          request.log.warn({ callCenter: slug, check }, 'rejected webhook signature');
          throw unauthorized();
        }
      },
    },
    async (request) => {
      const slug = String(request.headers[CALLCENTER_ID_HEADER]);
      const callCenter = await db.callCenter.findUnique({ where: { slug }, select: { id: true } });
      // Segredo configurado para um call center que não existe no banco: tratado como credencial inválida.
      if (!callCenter) throw unauthorized();

      const event = request.body;
      const occurredAt = new Date(event.timestamp);
      if (occurredAt.getTime() > Date.now() + SIGNATURE_TOLERANCE_SECONDS * 1000) {
        throw unprocessable('TIMESTAMP_IN_FUTURE', 'Event timestamp is in the future', [
          { path: 'timestamp', message: 'must not be more than 5 minutes in the future' },
        ]);
      }

      const result = await recordStatusEvent(db, {
        leadId: event.lead_id,
        toStatus: event.status,
        occurredAt,
        origin: 'webhook',
        // O timestamp normalizado faz "…Z" e "…+00:00" contarem como o mesmo evento.
        dedupKey: sha256Hex(
          [
            callCenter.id,
            event.lead_id,
            event.external_id ?? '',
            event.status,
            occurredAt.toISOString(),
          ].join('|'),
        ),
        scopeCallCenterId: callCenter.id,
        callCenterId: callCenter.id,
        actorUserId: null,
        externalId: event.external_id ?? null,
        payload: event,
      });

      return { success: true as const, ...result };
    },
  );
};
