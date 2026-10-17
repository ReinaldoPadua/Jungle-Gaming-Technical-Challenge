import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../../../shared/canonical-json';
import { WagerTransactionBody } from '../http/wager.schemas';
import { IdempotencyKeyHeader } from '../http/wager.schemas';

/** Envelope `WagerTransactionRequested` (seção 10 do desafio). Mesmo contrato do corpo HTTP. */
export const WagerTransactionRequestedMessage = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime({ offset: true }),
    data: WagerTransactionBody.extend({ idempotencyKey: IdempotencyKeyHeader }).strict(),
  })
  .strict();

export type WagerTransactionRequestedMessage = z.infer<typeof WagerTransactionRequestedMessage>;

export type ParsedMessage =
  | { ok: true; message: WagerTransactionRequestedMessage; contentHash: string }
  | { ok: false; reason: 'MALFORMED_JSON' | 'INVALID_ENVELOPE' | 'UNSUPPORTED_TYPE'; detail: string };

/** Valida o envelope. Falha aqui é PERMANENTE (nenhum retry vai consertar o payload). */
export function parseWagerMessage(body: string): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: 'MALFORMED_JSON', detail: err instanceof Error ? err.message : 'invalid JSON' };
  }
  const type = (json as { type?: unknown } | null)?.type;
  if (type !== 'WagerTransactionRequested') {
    return { ok: false, reason: 'UNSUPPORTED_TYPE', detail: `unsupported message type ${JSON.stringify(type)}` };
  }
  const parsed = WagerTransactionRequestedMessage.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'INVALID_ENVELOPE',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 1_000),
    };
  }
  // hash do conteúdo da mensagem (inbox): canônico → independente de ordem de chaves/espaços
  const contentHash = createHash('sha256').update(canonicalJson(parsed.data), 'utf8').digest('hex');
  return { ok: true, message: parsed.data, contentHash };
}
