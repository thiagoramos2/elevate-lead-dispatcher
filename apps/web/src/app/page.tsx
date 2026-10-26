'use client';

import {
  catalogResponseSchema,
  listLeadsResponseSchema,
  metricsResponseSchema,
} from '@elevate/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { type FilterValues, LeadFilters } from '@/components/lead-filters';
import { LeadTable } from '@/components/lead-table';
import { MetricsGrid } from '@/components/metrics';
import { api, toQuery } from '@/lib/api';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 25;

/** Data do input (AAAA-MM-DD, horário local) → instante ISO. `to` é exclusivo: vira o dia seguinte. */
function toApiFilters(values: FilterValues) {
  const startOf = (day: string, plusDays = 0) => {
    const date = new Date(`${day}T00:00:00`);
    date.setDate(date.getDate() + plusDays);
    return date.toISOString();
  };
  return {
    from: values.from ? startOf(values.from) : undefined,
    to: values.to ? startOf(values.to, 1) : undefined,
    product: values.product || undefined,
    funnel: values.funnel || undefined,
    source: values.source.trim() || undefined,
    callCenter: values.callCenter || undefined,
    status: values.status || undefined,
  };
}

function Dashboard() {
  const { user } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Filtros vivem na URL: a visão é compartilhável e sobrevive a um refresh.
  const values = useMemo<FilterValues>(
    () => ({
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      product: params.get('product') ?? '',
      funnel: params.get('funnel') ?? '',
      source: params.get('source') ?? '',
      callCenter: params.get('callCenter') ?? '',
      status: params.get('status') ?? '',
    }),
    [params],
  );
  const filters = useMemo(() => toApiFilters(values), [values]);
  const filterKey = toQuery(filters);

  // Pilha de cursores (keyset): voltar uma página é desempilhar.
  const [cursors, setCursors] = useState<{ key: string; stack: string[] }>({ key: '', stack: [] });
  const stack = cursors.key === filterKey ? cursors.stack : [];
  const cursor = stack.at(-1);

  const setFilters = (next: Partial<FilterValues>) => {
    const merged = { ...values, ...next };
    router.replace(`${pathname}${toQuery(merged)}`, { scroll: false });
  };

  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api('/api/catalog', catalogResponseSchema),
    staleTime: 5 * 60_000,
  });
  const metrics = useQuery({
    queryKey: ['metrics', filterKey],
    queryFn: () => api(`/api/leads/metrics${filterKey}`, metricsResponseSchema),
    refetchInterval: 15_000,
  });
  const leads = useQuery({
    queryKey: ['leads', filterKey, cursor],
    queryFn: () =>
      api(
        `/api/leads${toQuery({ ...filters, cursor, limit: PAGE_SIZE })}`,
        listLeadsResponseSchema,
      ),
    placeholderData: keepPreviousData,
  });

  const page = leads.data;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {user?.role === 'operator'
              ? `Leads distribuídos para ${user.callCenterName ?? 'o seu call center'}.`
              : 'Todos os leads recebidos, distribuídos e acompanhados.'}
          </p>
        </div>
      </div>

      <MetricsGrid metrics={metrics.data} />

      <LeadFilters
        values={values}
        catalog={catalog.data}
        showCallCenter={user?.role === 'admin'}
        onChange={setFilters}
        onClear={() => router.replace(pathname, { scroll: false })}
      />

      {leads.error ? (
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar os leads: {leads.error.message}
        </p>
      ) : (
        <LeadTable leads={page?.items ?? []} loading={leads.isLoading} />
      )}

      <div className="flex items-center justify-between text-sm">
        <span className="text-ink-faint">Página {stack.length + 1}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={stack.length === 0}
            onClick={() => setCursors({ key: filterKey, stack: stack.slice(0, -1) })}
            className="h-9 rounded-md border border-line px-3 transition-colors hover:border-line-strong disabled:opacity-40"
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={!page?.nextCursor}
            onClick={() =>
              page?.nextCursor && setCursors({ key: filterKey, stack: [...stack, page.nextCursor] })
            }
            className="h-9 rounded-md border border-line px-3 transition-colors hover:border-line-strong disabled:opacity-40"
          >
            Próxima
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AppShell>
      <Suspense>
        <Dashboard />
      </Suspense>
    </AppShell>
  );
}
