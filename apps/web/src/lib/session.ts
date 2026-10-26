'use client';

import { type SessionUser, sessionResponseSchema } from '@elevate/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, api } from './api';

/**
 * Usuário da sessão atual. Sem sessão válida, manda para o login. Isto é só experiência de uso:
 * quem protege os dados é o backend, que valida a sessão e o perfil em toda requisição.
 */
export function useSession(): { user: SessionUser | undefined; isLoading: boolean } {
  const router = useRouter();
  const query = useQuery({
    queryKey: ['session'],
    queryFn: () => api('/api/auth/me', sessionResponseSchema),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) router.replace('/login');
  }, [query.error, router]);

  return { user: query.data?.user, isLoading: query.isLoading };
}
