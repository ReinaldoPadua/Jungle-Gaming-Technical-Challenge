import { createApp } from './bootstrap';
import { loadEnv } from './config/env';
import { APP_LOGGER, type AppLogger } from './shared/application/logger';

const env = loadEnv();
const app = await createApp();
await app.listen(env.PORT);
app.get<AppLogger>(APP_LOGGER).info('http server listening', { port: env.PORT });
