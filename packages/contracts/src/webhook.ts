import { z } from 'zod';
import { leadStatusSchema } from './enums.js';

export const CALLCENTER_ID_HEADER = 'x-callcenter-id';
export const SIGNATURE_HEADER = 'x-signature';

/** Payload accepted by POST /api/webhooks/callcenter. */
export const callCenterWebhookSchema = z.object({
  lead_id: z.uuid(),
  external_id: z.string().trim().min(1).max(128).optional(),
  status: leadStatusSchema,
  timestamp: z.iso.datetime({ offset: true }),
});
export type CallCenterWebhookPayload = z.infer<typeof callCenterWebhookSchema>;

export const callCenterWebhookResponseSchema = z.object({
  success: z.literal(true),
  duplicate: z.boolean(),
  applied: z.boolean(),
  reason: z.enum(['stale', 'invalid_transition']).optional(),
  status: leadStatusSchema,
});
export type CallCenterWebhookResponse = z.infer<typeof callCenterWebhookResponseSchema>;
