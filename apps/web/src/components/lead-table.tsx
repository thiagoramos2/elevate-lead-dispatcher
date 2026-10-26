import type { LeadListItem } from '@elevate/contracts';
import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import { DistributionLabel, StatusBadge } from './badges';

const th = 'px-4 py-2.5 text-left text-xs font-medium text-ink-faint';
const td = 'px-4 py-3 align-top';

export function LeadTable({ leads, loading }: { leads: LeadListItem[]; loading: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[960px] text-sm">
        <thead className="border-b border-line bg-surface">
          <tr>
            <th className={th}>Lead</th>
            <th className={th}>Produto · Funil</th>
            <th className={th}>Origem</th>
            <th className={th}>Call center</th>
            <th className={th}>Status</th>
            <th className={th}>Recebido em</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {leads.map((lead) => (
            <tr key={lead.id} className="transition-colors hover:bg-surface">
              <td className={td}>
                <Link href={`/leads/${lead.id}`} className="font-medium hover:text-accent-strong">
                  {lead.name}
                </Link>
                <p className="text-xs text-ink-faint">{lead.email}</p>
              </td>
              <td className={td}>
                {lead.product.name}
                <p className="font-mono text-xs text-ink-faint">{lead.funnel.slug}</p>
              </td>
              <td className={td}>
                {lead.source}
                {lead.campaign && <p className="text-xs text-ink-faint">{lead.campaign}</p>}
              </td>
              <td className={td}>
                {lead.callCenter?.name ?? <span className="text-ink-faint">—</span>}
                <p>
                  <DistributionLabel status={lead.distributionStatus} />
                </p>
              </td>
              <td className={td}>
                <StatusBadge status={lead.status} />
              </td>
              <td
                className={`${td} whitespace-nowrap font-mono text-xs text-ink-muted tabular-nums`}
              >
                {formatDateTime(lead.createdAt)}
              </td>
            </tr>
          ))}
          {!loading && leads.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-12 text-center text-sm text-ink-faint">
                Nenhum lead encontrado para estes filtros.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
