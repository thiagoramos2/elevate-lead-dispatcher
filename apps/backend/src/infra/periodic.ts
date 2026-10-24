import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';

export interface PeriodicTask {
  /** Stops scheduling and waits for the iteration in progress to finish. */
  stop(): Promise<void>;
}

/**
 * Runs `task` forever: again immediately while it reports more work, otherwise after
 * `intervalMs`. Errors are logged and never kill the loop.
 */
export function runPeriodically(
  name: string,
  task: () => Promise<boolean>,
  intervalMs: number,
  logger: Logger,
): PeriodicTask {
  const controller = new AbortController();

  const loop = (async () => {
    while (!controller.signal.aborted) {
      let moreWork = false;
      try {
        moreWork = await task();
      } catch (error) {
        logger.error({ err: error, task: name }, 'periodic task failed');
      }
      if (moreWork) continue;
      await sleep(intervalMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();

  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}
