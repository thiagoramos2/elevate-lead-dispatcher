'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/session';

const navLink = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink'
  }`;

export function AppShell({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    queryClient.clear();
    router.replace('/login');
  };

  if (isLoading || !user) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-ink-faint">Carregando…</div>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="grid size-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-canvas">
              E
            </span>
            Lead Dispatcher
          </Link>
          <nav className="flex items-center gap-1">
            <Link href="/" className={navLink(pathname === '/' || pathname.startsWith('/leads'))}>
              Leads
            </Link>
            {user.role === 'admin' && (
              <Link href="/admin" className={navLink(pathname.startsWith('/admin'))}>
                Dispatcher
              </Link>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-ink-muted sm:inline">{user.email}</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted">
              {user.role === 'admin' ? 'Admin' : `Operador · ${user.callCenterName ?? ''}`}
            </span>
            <button
              type="button"
              onClick={logout}
              className="text-ink-muted transition-colors hover:text-ink"
            >
              Sair
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
