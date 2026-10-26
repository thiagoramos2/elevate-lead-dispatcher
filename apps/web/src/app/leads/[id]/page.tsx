'use client';

import { LEAD_STATUSES, type LeadStatus, leadDetailSchema } from '@elevate/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { z } from 'zod';
import { AppShell } from '@/components/app-shell';
import { DistributionLabel, StatusBadge } from '@/components/badges';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, STATUS_LABEL } from '@/lib/format';

const ORIGIN_LABEL = { system: 'Sistema', webhook: 'Call center', operator: 'Operador' } as const;
const REJECTION_LABEL: Record<string, string> = {
  stale: 'ignorado: mais antigo que o status atual',
  invalid_transition: 'recusado: transição não permitida',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm">{children ?? <span className="text-ink-faint">—</span>}</dd>
    </div>
  );
}

function LeadDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [next, setNext] = useState<LeadStatus | ''>('');

  const lead = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api(`/api/leads/${id}`, leadDetailSchema),
  });

  const update = useMutation({
    mutationFn: (status: LeadStatus) =>
      api(`/api/leads/${id}/status`, z.object({ success: z.literal(true) }), {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: async () => {
      setNext('');
      await queryClient.invalidateQueries({ queryKey: ['lead', id] });
      await queryClient.invalidateQueries({ queryKey: ['leads'] });
      await queryClient.invalidateQueries({ queryKey: ['metrics'] });
    },
  });

  if (lead.error) {
    const notFound = lead.error instanceof ApiError && lead.error.status === 404;
    return (
      <p role="alert" className="text-sm text-danger">
        {notFound ? 'Lead não encontrado.' : `Erro ao carregar o lead: ${lead.error.message}`}
      </p>
    );
  }
  if (!lead.data) return <p className="text-sm text-ink-faint">Carregando…</p>;
  const l = lead.data;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-ink-muted hover:text-ink">
          ← Leads
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{l.name}</h1>
          <StatusBadge status={l.status} />
        </div>
        <p className="mt-1 font-mono text-xs text-ink-faint">{l.id}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-line bg-surface p-5 lg:col-span-2">
          <h2 className="text-sm font-medium">Dados do lead</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
            <Field label="E-mail">{l.email}</Field>
            <Field label="Telefone">{l.phone}</Field>
            <Field label="Recebido em">{formatDateTime(l.createdAt)}</Field>
            <Field label="Produto">{l.product.name}</Field>
            <Field label="Funil">{l.funnel.slug}</Field>
            <Field label="Afiliado">{l.affiliate}</Field>
            <Field label="Origem">{l.source}</Field>
            <Field label="Campanha">{l.campaign}</Field>
            <Field label="Call center">
              {l.callCenter?.name} <DistributionLabel status={l.distributionStatus} />
            </Field>
            <Field label="UTM source">{l.utm.source}</Field>
            <Field label="UTM medium">{l.utm.medium}</Field>
            <Field label="UTM content">{l.utm.content}</Field>
          </dl>
        </section>

        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Atualizar status</h2>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (next) update.mutate(next);
            }}
          >
            <label className="block space-y-1.5 text-xs text-ink-muted">
              Novo status
              <select
                className="h-9 w-full rounded-md border border-line bg-canvas px-2.5 text-sm text-ink outline-none focus:border-accent"
                value={next}
                onChange={(e) => setNext(e.target.value === '' ? '' : leadStatusOf(e.target.value))}
              >
                <option value="">Selecione…</option>
                {LEAD_STATUSES.filter((s) => s !== 'new' && s !== l.status).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={!next || update.isPending}
              className="h-9 w-full rounded-md bg-accent text-sm font-medium text-canvas transition-colors hover:bg-accent-strong disabled:opacity-50"
            >
              {update.isPending ? 'Salvando…' : 'Salvar'}
            </button>
            {update.error && (
              <p role="alert" className="text-xs text-danger">
                {update.error instanceof ApiError && update.error.code === 'INVALID_TRANSITION'
                  ? 'Transição não permitida a partir do status atual.'
                  : update.error.message}
              </p>
            )}
          </form>
        </section>
      </div>

      <section>
        <h2 className="text-sm font-medium">Histórico</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Todo evento recebido fica registrado, inclusive os ignorados (fora de ordem) e os
          recusados.
        </p>
        <ol className="mt-4 space-y-px overflow-hidden rounded-xl border border-line bg-line">
          {l.events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-surface px-4 py-3 text-sm"
            >
              <span className="w-36 font-mono text-xs text-ink-muted tabular-nums">
                {formatDateTime(event.occurredAt)}
              </span>
              <span className={event.applied ? '' : 'text-ink-faint line-through'}>
                {event.fromStatus ? `${STATUS_LABEL[event.fromStatus]} → ` : ''}
                {STATUS_LABEL[event.toStatus]}
              </span>
              <span className="text-xs text-ink-faint">
                {ORIGIN_LABEL[event.origin]}
                {event.actorEmail ? ` · ${event.actorEmail}` : ''}
                {event.externalId ? ` · ref ${event.externalId}` : ''}
              </span>
              {!event.applied && event.rejectionReason && (
                <span className="text-xs text-warning">
                  {REJECTION_LABEL[event.rejectionReason] ?? event.rejectionReason}
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** Converte o valor do <select> no tipo do domínio sem cast: valida contra a lista conhecida. */
function leadStatusOf(value: string): LeadStatus | '' {
  return LEAD_STATUSES.find((s) => s === value) ?? '';
}

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  return (
    <AppShell>
      <LeadDetail id={params.id} />
    </AppShell>
  );
}
