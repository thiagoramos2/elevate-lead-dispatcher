import { z } from 'zod';

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'no_answer',
  'callback',
  'qualified',
  'sale',
  'refund',
  'invalid',
] as const;
export const leadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

export const DISTRIBUTION_STATUSES = ['pending', 'distributed', 'failed'] as const;
export const distributionStatusSchema = z.enum(DISTRIBUTION_STATUSES);
export type DistributionStatus = z.infer<typeof distributionStatusSchema>;

export const USER_ROLES = ['admin', 'operator'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;
