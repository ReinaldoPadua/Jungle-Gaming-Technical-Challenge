/**
 * Pontos de injeção de falha para os testes de recuperação (processo morre
 * num ponto exato). Desligado por padrão; só ativa com FAULTS=<ponto>[,<ponto>]
 * e nunca em NODE_ENV=production.
 */
export type FaultPoint =
  /** outbox: evento enviado ao broker, mas published_at ainda não gravado */
  | 'outbox:after-publish'
  /** consumidor SQS: transação SQL confirmada, mensagem ainda não deletada (ack) */
  | 'consumer:after-commit-before-ack';

export interface Faults {
  /** Se o ponto estiver armado, encerra o processo abruptamente (simula crash). */
  hit(point: FaultPoint): void;
}

export const FAULTS = Symbol('FAULTS');

export const noFaults: Faults = { hit: () => {} };

export function faultsFromEnv(env: { FAULTS?: string; NODE_ENV?: string }): Faults {
  const armed = new Set((env.FAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (armed.size === 0) return noFaults;
  if (env.NODE_ENV === 'production') throw new Error('FAULTS cannot be armed in production');
  return {
    hit(point) {
      if (!armed.has(point)) return;
      process.stdout.write(`${JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg: 'fault injected: exiting process', point })}\n`);
      // exit imediato: nenhum finally/flush/ack roda — é exatamente um crash
      process.exit(137);
    },
  };
}
