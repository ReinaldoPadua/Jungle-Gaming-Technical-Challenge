import { createApp } from './bootstrap';
import { loadEnv } from './config/env';

const env = loadEnv();
const app = await createApp();
await app.listen(env.PORT);
console.log(JSON.stringify({ level: 'info', msg: 'http server listening', port: env.PORT, instanceId: env.INSTANCE_ID }));
