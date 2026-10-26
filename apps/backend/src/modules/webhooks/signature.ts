import { createHmac, timingSafeEqual } from 'node:crypto';

/** Janela aceita entre o `t` assinado e o relógio do servidor, nos dois sentidos (ADR-0005). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = 'valid' | 'malformed' | 'expired' | 'mismatch';

function hmacHex(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Gera o header `X-Signature: t=<unix>,v1=<hex>`. Usado pelos testes e pelo script de
 * demonstração; documenta para o parceiro exatamente o que precisa ser assinado.
 */
export function signPayload(secret: string, rawBody: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacHex(secret, timestamp, rawBody)}`;
}

function parseHeader(header: string): { timestamp: number; signature: string } | null {
  const parts = new Map(
    header.split(',').map((part) => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const;
    }),
  );
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return null;
  return { timestamp: Number(t), signature: v1 };
}

/**
 * Verifica a assinatura HMAC-SHA256 de `"<t>.<corpo bruto>"`.
 * - O corpo precisa ser o bruto, byte a byte: um JSON re-serializado não bate.
 * - A comparação é em tempo constante (`timingSafeEqual`), para não vazar a assinatura por timing.
 * - O `t` fora da janela é rejeitado: uma requisição capturada não pode ser reenviada depois
 *   dela; dentro dela, a deduplicação de eventos cobre o replay.
 */
export function verifySignature(input: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  nowSeconds: number;
}): SignatureCheck {
  if (!input.header) return 'malformed';
  const parsed = parseHeader(input.header);
  if (!parsed) return 'malformed';
  if (Math.abs(input.nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return 'expired';

  const expected = Buffer.from(hmacHex(input.secret, parsed.timestamp, input.rawBody), 'hex');
  const received = Buffer.from(parsed.signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? 'valid'
    : 'mismatch';
}
