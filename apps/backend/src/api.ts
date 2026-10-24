import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabase } from './infra/prisma.js';

const config = loadConfig();
const db = createDatabase({ url: config.DATABASE_URL, poolMax: config.DB_POOL_MAX });
const app = await buildApp({ config, db });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down: draining in-flight requests');
  try {
    await app.close();
    await db.$disconnect();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
