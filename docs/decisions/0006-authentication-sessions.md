# ADR-0006 — Autenticação por sessão opaca

**Status:** aceito · **Data:** 2026-10-23

## Decisão

- Login com e-mail e senha. Senha com **argon2id** (`@node-rs/argon2`, parâmetros OWASP).
- Sessão: token aleatório de 256 bits em cookie `eld_session` (`HttpOnly; SameSite=Strict; Path=/`, e `Secure` conforme `COOKIE_SECURE`). No banco fica só `sha256(token)`, então um dump do banco não dá sessões válidas.
- **Ajuste na implementação:** o plano previa o prefixo `__Host-`, que exige `Secure`. O Compose de demonstração roda em `http://localhost`, e um cookie `Secure` pode ser descartado conforme o navegador e o host usados pelo avaliador, travando o login. Por isso `Secure` virou configuração: ligado por padrão em `NODE_ENV=production` e desligado explicitamente no Compose local. Em produção (HTTPS), o correto é `COOKIE_SECURE=true` e o prefixo `__Host-`.
- Expiração de 8h, deslizante. Logout apaga a linha.
- Sessões no **Postgres**, não no Redis: login não deve depender do componente que é só transporte.

## CSRF

`SameSite=Strict` + checagem de `Origin` em métodos mutáveis + rotas autenticadas só aceitam `application/json` (um formulário HTML entre sites não consegue enviar JSON sem CORS preflight).

## Brute force

Rate limit por IP em `/api/auth/login` (Redis). Bloqueio por conta: 5 falhas → 15 min. Resposta genérica `401 INVALID_CREDENTIALS` também para usuário inexistente, com hash dummy para igualar o tempo de resposta.

## Autorização

- Guard `requireUser(db, ttl, ['admin'])` nas rotas administrativas (`modules/auth/guards.ts`).
- Para OPERATOR, o escopo `call_center_id` vem **da sessão** e é aplicado no service. Parâmetros do cliente são ignorados para esse campo. Lead de outro call center → `404`.

## Alternativas

JWT stateless: sem revogação imediata e fácil de errar (armazenamento no browser, algoritmo). Não traz ganho com um único backend.
