'use client';

import { dispatcherConfigSchema, listLeadsResponseSchema } from '@elevate/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { z } from 'zod';
import { AppShell } from '@/components/app-shell';
import { api } from '@/lib/api';
import { formatDateTime, formatInteger, formatPercent } from '@/lib/format';
import { useSession } from '@/lib/session';

type Draft = Record<string, { weight: number; active: boolean }>;

function DispatcherAdmin() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const config = useQuery({
    queryKey: ['dispatcher'],
    queryFn: () => api('/api/admin/dispatcher', dispatcherConfigSchema),
    refetchInterval: 10_000,
  });
  const failed = useQuery({
    queryKey: ['leads', 'failed'],
    queryFn: () => api('/api/leads?distribution=failed&limit=50', listLeadsResponseSchema),
    refetchInterval: 10_000,
  });

  const save = useMutation({
    mutationFn: (next: Draft) =>
      api('/api/admin/dispatcher', dispatcherConfigSchema, {
        method: 'PUT',
        body: { callCenters: Object.entries(next).map(([id, value]) => ({ id, ...value })) },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['dispatcher'], data);
      setDraft(null);
    },
  });

  const redistribute = useMutation({
    mutationFn: (leadId: string) =>
      api(`/api/admin/leads/${leadId}/redistribute`, z.object({ success: z.literal(true) }), {
        method: 'POST',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });

  if (!config.data) return <p className="text-sm text-ink-faint">Carregando…</p>;
  const centers = config.data.callCenters;
  const current: Draft =
    draft ?? Object.fromEntries(centers.map((c) => [c.id, { weight: c.weight, active: c.active }]));
  const activeWeight = centers.reduce(
    (sum, c) => sum + (current[c.id]?.active ? (current[c.id]?.weight ?? 0) : 0),
    0,
  );
  const edit = (id: string, patch: Partial<{ weight: number; active: boolean }>) => {
    const base = current[id];
    if (base) setDraft({ ...current, [id]: { ...base, ...patch } });
  };

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dispatcher</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Distribuição ponderada (smooth weighted round robin). Alterar pesos ou desativar um call
          center reinicia o escalonamento a partir do próximo lead. Versão da configuração:{' '}
          <span className="font-mono text-ink">v{config.data.configVersion}</span>
        </p>
      </div>

      <section className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface text-xs text-ink-faint">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Call center</th>
              <th className="px-4 py-2.5 text-left font-medium">Ativo</th>
              <th className="px-4 py-2.5 text-left font-medium">Peso</th>
              <th className="px-4 py-2.5 text-left font-medium">Participação</th>
              <th className="px-4 py-2.5 text-right font-medium">Leads recebidos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {centers.map((center) => {
              const value = current[center.id];
              const share = value?.active && activeWeight > 0 ? value.weight / activeWeight : 0;
              return (
                <tr key={center.id}>
                  <td className="px-4 py-3">
                    {center.name}
                    <p className="font-mono text-xs text-ink-faint">{center.slug}</p>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Ativar ${center.name}`}
                      className="size-4 accent-[var(--color-accent)]"
                      checked={value?.active ?? false}
                      onChange={(e) => edit(center.id, { active: e.target.checked })}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      aria-label={`Peso de ${center.name}`}
                      className="h-8 w-24 rounded-md border border-line bg-canvas px-2 font-mono text-sm outline-none focus:border-accent"
                      value={value?.weight ?? 1}
                      onChange={(e) =>
                        edit(center.id, {
                          weight: Math.max(1, Math.round(Number(e.target.value) || 1)),
                        })
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-raised">
                        <div className="h-full bg-accent" style={{ width: `${share * 100}%` }} />
                      </div>
                      <span className="font-mono text-xs tabular-nums">{formatPercent(share)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatInteger(center.distributedTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-center justify-end gap-3 border-t border-line bg-surface px-4 py-3">
          {save.error && (
            <p role="alert" className="mr-auto text-xs text-danger">
              {save.error.message}
            </p>
          )}
          {draft && (
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-sm text-ink-muted hover:text-ink"
            >
              Descartar
            </button>
          )}
          <button
            type="button"
            disabled={!draft || save.isPending || activeWeight === 0}
            onClick={() => draft && save.mutate(draft)}
            className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-canvas transition-colors hover:bg-accent-strong disabled:opacity-40"
          >
            {save.isPending ? 'Salvando…' : 'Salvar configuração'}
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium">Leads com distribuição falha</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Esgotaram as tentativas automáticas. Depois de corrigir a causa (ex.: reativar um call
          center), reprocesse.
        </p>
        <ul className="mt-4 space-y-px overflow-hidden rounded-xl border border-line bg-line">
          {failed.data?.items.map((lead) => (
            <li key={lead.id} className="flex items-center gap-4 bg-surface px-4 py-3 text-sm">
              <Link href={`/leads/${lead.id}`} className="hover:text-accent-strong">
                {lead.name}
              </Link>
              <span className="font-mono text-xs text-ink-faint">
                {formatDateTime(lead.createdAt)}
              </span>
              <button
                type="button"
                disabled={redistribute.isPending}
                onClick={() => redistribute.mutate(lead.id)}
                className="ml-auto h-8 rounded-md border border-line px-3 text-xs transition-colors hover:border-line-strong disabled:opacity-40"
              >
                Reprocessar
              </button>
            </li>
          ))}
          {failed.data?.items.length === 0 && (
            <li className="bg-surface px-4 py-6 text-center text-sm text-ink-faint">
              Nenhum lead com falha de distribuição.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

export default function AdminPage() {
  const { user } = useSession();
  return (
    <AppShell>
      {user?.role === 'admin' ? (
        <DispatcherAdmin />
      ) : (
        <p className="text-sm text-ink-muted">Área restrita a administradores.</p>
      )}
    </AppShell>
  );
}
