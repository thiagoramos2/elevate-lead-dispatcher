import { pino } from 'pino';
import { loadConfig } from './config/env.js';
import { loggerOptions } from './infra/logger.js';
import { runPeriodically } from './infra/periodic.js';
import { createDatabase } from './infra/prisma.js';
import {
  createDistributionWorker,
  queuePublisher,
} from './modules/dispatch/distribution-worker.js';
import { OutboxRelay } from './modules/dispatch/outbox-relay.js';
import { createDistributionQueue } from './modules/dispatch/queue.js';
import { DistributionReconciler } from './modules/dispatch/reconciler.js';

const RELAY_INTERVAL_MS = 500;
const RECONCILE_INTERVAL_MS = 60_000;

const config = loadConfig();
const logger = pino(loggerOptions(config.LOG_LEVEL, config.NODE_ENV === 'development'));
const db = createDatabase({ url: config.DATABASE_URL, poolMax: config.DB_POOL_MAX });
const queue = createDistributionQueue(config.REDIS_URL);
queue.on('error', (error) => logger.warn({ err: error }, 'queue connection error'));

const relay = new OutboxRelay(db, queuePublisher(queue), logger);
const reconciler = new DistributionReconciler(db, queue, logger);
const worker = createDistributionWorker({
  db,
  redisUrl: config.REDIS_URL,
  concurrency: config.WORKER_CONCURRENCY,
  logger,
});

const tasks = [
  runPeriodically(
    'outbox-relay',
    async () => (await relay.publishBatch()) > 0,
    RELAY_INTERVAL_MS,
    logger,
  ),
  runPeriodically(
    'reconciler',
    async () => {
      await reconciler.requeueLostJobs();
      await reconciler.purgePublishedOutbox();
      return false;
    },
    RECONCILE_INTERVAL_MS,
    logger,
  ),
];
logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down: finishing active jobs');
  try {
    await Promise.all(tasks.map((task) => task.stop()));
    // Waits for active jobs; anything not finished is picked up again via stalled-job checks.
    await worker.close();
    await queue.close();
    await db.$disconnect();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
