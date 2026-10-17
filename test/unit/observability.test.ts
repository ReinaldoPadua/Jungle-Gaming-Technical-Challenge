import { afterEach, describe, expect, test } from 'bun:test';
import { JsonLogger, redact, setLogSink } from '../../src/infrastructure/observability/json-logger';
import { logContext } from '../../src/shared/application/log-context';

let restore: (() => void) | undefined;
afterEach(() => restore?.());
const capture = () => {
  const lines: Record<string, unknown>[] = [];
  restore = setLogSink((l) => lines.push(JSON.parse(l)));
  return lines;
};

describe('JsonLogger', () => {
  test('uma linha JSON com nível, horário, mensagem, serviço e instância', () => {
    const lines = capture();
    new JsonLogger({ level: 'info', service: 'wagering', instanceId: 'i-1' }).info('hello', { attempt: 2 });
    expect(lines).toEqual([{ level: 'info', time: expect.any(String), msg: 'hello', service: 'wagering', instanceId: 'i-1', attempt: 2 }]);
  });

  test('inclui automaticamente os campos de correlação do contexto', async () => {
    const lines = capture();
    const logger = new JsonLogger({ level: 'info' });
    await logContext.run({ correlationId: 'c-1', messageId: 'm-1' }, async () => {
      await Bun.sleep(1);
      logContext.enrich({ transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' });
      logger.info('inside');
    });
    expect(lines[0]).toMatchObject({ correlationId: 'c-1', messageId: 'm-1', transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' });
  });

  test('filtra por nível', () => {
    const lines = capture();
    const logger = new JsonLogger({ level: 'warn' });
    logger.info('no');
    logger.debug?.('no');
    logger.warn('yes');
    logger.error('yes');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  test('erros são serializados com nome, mensagem, code e stack curto', () => {
    const lines = capture();
    new JsonLogger({ level: 'info' }).error('boom', { error: Object.assign(new Error('deadlock'), { code: '40P01' }) });
    expect(lines[0]!.error).toMatchObject({ name: 'Error', message: 'deadlock', code: '40P01', stack: expect.any(String) });
  });
});

describe('redação de dados sensíveis', () => {
  test('valores monetários, payloads e credenciais nunca aparecem', () => {
    const out = redact({
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
      nested: { payload: { anything: 1 }, authorization: 'Bearer x', amount: '1.00', keep: 'ok' },
      list: [{ initialBalance: { amount: '1000.00' } }],
      status: 'PROCESSED',
    });
    expect(out).toEqual({
      money: '[REDACTED]',
      balanceAfter: '[REDACTED]',
      nested: { payload: '[REDACTED]', authorization: '[REDACTED]', amount: '[REDACTED]', keep: 'ok' },
      list: [{ initialBalance: '[REDACTED]' }],
      status: 'PROCESSED',
    });
    expect(JSON.stringify(out)).not.toMatch(/\d+\.\d{2}/);
  });
});

describe('logContext', () => {
  test('fluxos concorrentes não se misturam', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        logContext.run({ correlationId: id }, async () => {
          await Bun.sleep(Math.random() * 10);
          logContext.enrich({ transactionId: `tx-${id}` });
          await Bun.sleep(Math.random() * 10);
          seen.push(`${logContext.current().correlationId}:${logContext.current().transactionId}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a:tx-a', 'b:tx-b', 'c:tx-c']);
  });

  test('contexto aninhado herda e sobrepõe; fora de run() está vazio', () => {
    logContext.run({ correlationId: 'outer', walletId: 'w' }, () => {
      logContext.run({ messageId: 'm' }, () => {
        expect(logContext.current()).toEqual({ correlationId: 'outer', walletId: 'w', messageId: 'm' });
      });
      expect(logContext.current().messageId).toBeUndefined();
    });
    expect(logContext.current()).toEqual({});
    logContext.enrich({ walletId: 'ignored' }); // sem contexto: no-op
    expect(logContext.current()).toEqual({});
  });
});
