/**
 * Sobe UMA instância HTTP da aplicação (processo próprio, pool próprio).
 * INSTANCE_MODULE=workers inclui o worker de PENDING_REFERENCE.
 * Imprime "READY <url>" quando está aceitando conexões.
 */
import { startHttpApp, WalletHttpTestModule, WorkersHttpTestModule } from './http-app';

const module = process.env.INSTANCE_MODULE === 'workers' ? WorkersHttpTestModule : WalletHttpTestModule;
const app = await startHttpApp(module, Number(process.env.PORT ?? 0));
console.log(`READY ${app.url}`);

const shutdown = async () => {
  await app.close(); // beforeApplicationShutdown → workers param → ORM fecha
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
