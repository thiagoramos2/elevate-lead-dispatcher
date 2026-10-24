import { isValidPhoneNumber, parsePhoneNumberWithError } from 'libphonenumber-js';
import { z } from 'zod';

/** Catalog identifiers (product, funnel) are lowercase slugs. Existence is checked by the API. */
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be a slug: lowercase letters, digits, "-" or "_"');

/** Free-form tracking values (campaign names, ad ids). Bounded, no control characters. */
const trackingValue = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'must not contain control characters');

const phone = z
  .string()
  .trim()
  .max(32)
  .refine((value) => value.startsWith('+') && isValidPhoneNumber(value), {
    message: 'must be a valid phone number in international format, e.g. +5511999999999',
  })
  .transform((value) => parsePhoneNumberWithError(value).number);

export const utmSchema = z
  .strictObject({
    source: trackingValue.optional(),
    medium: trackingValue.optional(),
    campaign: trackingValue.optional(),
    content: trackingValue.optional(),
    term: trackingValue.optional(),
  })
  .describe('UTM parameters. Unknown keys are rejected.');

/**
 * Payload accepted by POST /api/leads.
 * Unknown top-level keys are stripped (landing pages often send extra form fields);
 * the `utm` object is strict because its shape is a fixed standard.
 */
export const createLeadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  // Normalize before validating: format checks run before chained transforms in Zod.
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  phone,
  product: slug,
  funnel: slug,
  source: slug.optional(),
  campaign: trackingValue.optional(),
  affiliate_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 characters: letters, digits, "-" or "_"')
    .optional(),
  utm: utmSchema.optional(),
});

export type CreateLeadInput = z.input<typeof createLeadSchema>;
export type CreateLeadPayload = z.output<typeof createLeadSchema>;

export const createLeadResponseSchema = z.object({
  success: z.literal(true),
  lead_id: z.uuid(),
  duplicate: z.boolean(),
  distribution_status: z.enum(['pending', 'distributed', 'failed']),
});
export type CreateLeadResponse = z.infer<typeof createLeadResponseSchema>;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{8,255}$/, 'must be 8-255 printable ASCII characters');
