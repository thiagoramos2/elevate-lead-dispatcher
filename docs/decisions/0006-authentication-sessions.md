# ADR-0006 — Autenticação por sessão opaca

**Status:** aceito · **Data:** 2026-10-23

## Decisão

- Login com e-mail e senha. Senha com **argon2id** (`@node-rs/argon2`, parâmetros OWASP).
- Sessão: token aleatório de 256 bits em cookie `__Host-session` (`HttpOnly; Secure; SameSite=Strict; Path=/`). No banco fica só `sha256(token)`, então um dump do banco não dá sessões válidas.
- Expiração de 8h, deslizante. Logout apaga a linha.
- Sessões no **Postgres**, não no Redis: login não deve depender do componente que é só transporte.

## CSRF

`SameSite=Strict` + checagem de `Origin` em métodos mutáveis + rotas autenticadas só aceitam `application/json` (um formulário HTML entre sites não consegue enviar JSON sem CORS preflight).

## Brute force

Rate limit por IP em `/api/auth/login` (Redis). Bloqueio por conta: 5 falhas → 15 min. Resposta genérica `401 INVALID_CREDENTIALS` também para usuário inexistente, com hash dummy para igualar o tempo de resposta.

## Autorização

- `requireRole('admin')` nas rotas administrativas.
- Para OPERATOR, o escopo `call_center_id` vem **da sessão** e é aplicado no service. Parâmetros do cliente são ignorados para esse campo. Lead de outro call center → `404`.

## Alternativas

JWT stateless: sem revogação imediata e fácil de errar (armazenamento no browser, algoritmo). Não traz ganho com um único backend.
