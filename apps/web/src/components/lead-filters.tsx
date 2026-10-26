'use client';

import { type CatalogResponse, LEAD_STATUSES } from '@elevate/contracts';
import { STATUS_LABEL } from '@/lib/format';

/** Filtros como aparecem na URL (strings). Datas no formato do input: AAAA-MM-DD. */
// `type` (não `interface`) para ser aceito onde se espera um Record, como em `toQuery`.
export type FilterValues = {
  readonly from: string;
  readonly to: string;
  readonly product: string;
  readonly funnel: string;
  readonly source: string;
  readonly callCenter: string;
  readonly status: string;
};

export const FILTER_KEYS = [
  'from',
  'to',
  'product',
  'funnel',
  'source',
  'callCenter',
  'status',
] as const;

const field =
  'h-9 rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none transition-colors focus:border-accent';

interface Props {
  readonly values: FilterValues;
  readonly catalog: CatalogResponse | undefined;
  readonly showCallCenter: boolean;
  readonly onChange: (next: Partial<FilterValues>) => void;
  readonly onClear: () => void;
}

export function LeadFilters({ values, catalog, showCallCenter, onChange, onClear }: Props) {
  const funnels = catalog?.products.find((p) => p.id === values.product)?.funnels ?? [];
  const active = FILTER_KEYS.some((key) => values[key] !== '');

  return (
    <form
      aria-label="Filtros"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        De
        <input
          type="date"
          className={field}
          value={values.from}
          onChange={(e) => onChange({ from: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        Até
        <input
          type="date"
          className={field}
          value={values.to}
          onChange={(e) => onChange({ to: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        Produto
        <select
          className={field}
          value={values.product}
          onChange={(e) => onChange({ product: e.target.value, funnel: '' })}
        >
          <option value="">Todos</option>
          {catalog?.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        Funil
        <select
          className={field}
          value={values.funnel}
          disabled={!values.product}
          onChange={(e) => onChange({ funnel: e.target.value })}
        >
          <option value="">Todos</option>
          {funnels.map((f) => (
            <option key={f.id} value={f.id}>
              {f.slug}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        Origem
        <input
          type="text"
          placeholder="ex.: facebook"
          className={`${field} w-32`}
          value={values.source}
          onChange={(e) => onChange({ source: e.target.value })}
        />
      </label>
      {showCallCenter && (
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Call center
          <select
            className={field}
            value={values.callCenter}
            onChange={(e) => onChange({ callCenter: e.target.value })}
          >
            <option value="">Todos</option>
            {catalog?.callCenters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        Status
        <select
          className={field}
          value={values.status}
          onChange={(e) => onChange({ status: e.target.value })}
        >
          <option value="">Todos</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="h-9 px-2 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          Limpar
        </button>
      )}
    </form>
  );
}
