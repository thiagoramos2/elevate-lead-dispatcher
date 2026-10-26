'use client';

import { sessionResponseSchema } from '@elevate/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '@/lib/api';

const field =
  'h-10 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition-colors focus:border-accent';

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const session = await api('/api/auth/login', sessionResponseSchema, {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });
      queryClient.setQueryData(['session'], session);
      router.replace('/');
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 429
          ? 'Muitas tentativas. Aguarde um minuto e tente de novo.'
          : 'E-mail ou senha inválidos.',
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-canvas">
            E
          </span>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">Elevate Lead Dispatcher</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Entre para acompanhar a distribuição de leads.
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span className="text-ink-muted">E-mail</span>
            <input name="email" type="email" required autoComplete="username" className={field} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="text-ink-muted">Senha</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={field}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="h-10 w-full rounded-md bg-accent text-sm font-medium text-canvas transition-colors hover:bg-accent-strong disabled:opacity-60"
          >
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </main>
  );
}
