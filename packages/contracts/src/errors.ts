import { z } from 'zod';

/** Toda resposta não-2xx da API tem este formato. */
export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('Per-field validation errors'),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
