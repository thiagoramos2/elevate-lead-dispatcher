import type { DistributionStatus, LeadStatus } from '@elevate/contracts';
import { DISTRIBUTION_LABEL, STATUS_LABEL } from '@/lib/format';

const STATUS_TONE: Record<LeadStatus, string> = {
  new: 'text-info border-info/30 bg-info/10',
  contacted: 'text-ink border-line-strong bg-surface-raised',
  no_answer: 'text-ink-muted border-line bg-surface',
  callback: 'text-warning border-warning/30 bg-warning/10',
  qualified: 'text-accent-strong border-accent/30 bg-accent/10',
  sale: 'text-positive border-positive/30 bg-positive/10',
  refund: 'text-danger border-danger/30 bg-danger/10',
  invalid: 'text-ink-faint border-line bg-surface',
};

const DISTRIBUTION_TONE: Record<DistributionStatus, string> = {
  pending: 'text-warning',
  distributed: 'text-ink-muted',
  failed: 'text-danger',
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DistributionLabel({ status }: { status: DistributionStatus }) {
  return (
    <span className={`text-xs ${DISTRIBUTION_TONE[status]}`}>{DISTRIBUTION_LABEL[status]}</span>
  );
}
