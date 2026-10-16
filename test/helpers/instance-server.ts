/**
 * Sobe UMA instância HTTP da aplicação (processo próprio, pool próprio).
 * Usado pelos testes multi-instância: cada processo é uma réplica independente.
 * Imprime "READY <url>" quando está aceitando conexões.
 */
import { startHttpApp } from './http-app';

const app = await startHttpApp(undefined, Number(process.env.PORT ?? 0));
console.log(`READY ${app.url}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
