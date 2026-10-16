/**
 * Guardas estáticas: falhas eliminatórias que um teste consegue pegar no código-fonte.
 */
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

const read = async (pattern: string) => {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Glob(pattern).scan('.')) files.push({ path, text: await Bun.file(path).text() });
  return files;
};

describe('architecture guards', () => {
  test('nenhum campo monetário tipado como number', async () => {
    const offenders = (await read('src/**/*.ts')).filter(({ text }) =>
      /\b(amount|balance\w*|money)\??\s*:\s*number\b/i.test(text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  test('domínio não depende de NestJS, MikroORM nem AWS', async () => {
    const offenders = (await read('src/{shared,modules/*}/domain/**/*.ts')).filter(({ text }) =>
      /from ['"](@nestjs|@mikro-orm|@aws-sdk)/.test(text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  test('domínio não usa parseFloat/Number()/toFixed em valores', async () => {
    const offenders = (await read('src/{shared,modules/*}/domain/**/*.ts')).filter(({ text }) =>
      /\bparseFloat\(|\bNumber\(\s*\w*amount|\.toNumber\(\)/.test(text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
