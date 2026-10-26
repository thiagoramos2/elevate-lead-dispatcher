import type { MetricsResponse } from '@elevate/contracts';
import { formatInteger, formatPercent } from '@/lib/format';

interface Metric {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly emphasis?: boolean;
}

const grid =
  'grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3 xl:grid-cols-6';

function toMetrics(m: MetricsResponse): Metric[] {
  return [
    { label: 'Total de leads', value: formatInteger(m.total) },
    { label: 'Leads hoje', value: formatInteger(m.today) },
    { label: 'Distribuídos', value: formatInteger(m.distributed) },
    {
      label: 'Pendentes',
      value: formatInteger(m.pending),
      hint: `${formatInteger(m.awaitingContact)} aguardando contato · ${formatInteger(m.failed)} com falha`,
    },
    { label: 'Vendas', value: formatInteger(m.sales) },
    { label: 'Conversão', value: formatPercent(m.conversionRate), emphasis: true },
  ];
}

export function MetricsGrid({ metrics }: { metrics: MetricsResponse | undefined }) {
  if (!metrics) {
    return (
      <section aria-label="Métricas" aria-busy="true" className={grid}>
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <div key={key} className="bg-surface px-5 py-4">
            <div className="h-14 animate-pulse rounded bg-surface-raised" />
          </div>
        ))}
      </section>
    );
  }

  return (
    <section aria-label="Métricas" className={grid}>
      {toMetrics(metrics).map((item) => (
        <div key={item.label} className="bg-surface px-5 py-4">
          <p className="text-xs text-ink-muted">{item.label}</p>
          <p
            className={`mt-1 font-mono text-2xl tracking-tight tabular-nums ${item.emphasis ? 'text-accent-strong' : ''}`}
          >
            {item.value}
          </p>
          {item.hint && <p className="mt-1 text-[11px] text-ink-faint">{item.hint}</p>}
        </div>
      ))}
    </section>
  );
}
