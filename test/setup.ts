import 'reflect-metadata';

// Rede de segurança: a suíte trunca tabelas — nunca rodar contra o banco de dev.
const url = process.env.DATABASE_URL ?? '';
if (!/_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run tests: DATABASE_URL must point to a *_test database (got "${url}")`);
}
