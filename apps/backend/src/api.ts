import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabase } from './infra/prisma.js';

const config = loadConfig();
const db = createDatabase({ url: config.DATABASE_URL, poolMax: config.DB_POOL_MAX });
// Só para o rate limit. Fila offline desligada: com o Redis fora, o comando falha na hora e o rate
// limit é ignorado (skipOnError), em vez de a requisição ficar presa esperando.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
// Registrado antes de qualquer await: um erro de conexão na subida não pode ficar sem listener.
let redisErrorLogged = false;
redis.on('error', (error) => {
  if (redisErrorLogged) return; // o ioredis reconecta sozinho; evita inundar o log
  redisErrorLogged = true;
  console.warn(
    JSON.stringify({ level: 40, msg: 'redis (rate limit) unavailable', err: error.message }),
  );
});
redis.on('ready', () => {
  redisErrorLogged = false;
});
const app = await buildApp({ config, db, redis });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down: draining in-flight requests');
  try {
    await app.close();
    redis.disconnect();
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
