import { ValidationError } from '../../../shared/application/errors';

/**
 * Cursor opaco e estável do ledger: base64url de `{v, w, s}` —
 * versão do formato, wallet a que pertence e o último `sequence` entregue.
 * `sequence` é imutável e único por wallet, então inserções novas nunca
 * deslocam páginas já lidas (diferente de OFFSET).
 */
interface CursorPayload {
  v: 1;
  w: string;
  s: number;
}

export const LedgerCursor = {
  encode(walletId: string, lastSequence: number): string {
    const payload: CursorPayload = { v: 1, w: walletId, s: lastSequence };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  },

  /** @throws ValidationError se malformado ou emitido para outra wallet */
  decode(cursor: string, walletId: string): number {
    let payload: Partial<CursorPayload>;
    try {
      payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    } catch {
      throw new ValidationError('invalid cursor', undefined, 'INVALID_CURSOR');
    }
    if (payload?.v !== 1 || payload.w !== walletId || !Number.isSafeInteger(payload.s) || (payload.s ?? 0) < 1) {
      throw new ValidationError('invalid cursor', undefined, 'INVALID_CURSOR');
    }
    return payload.s!;
  },
};
