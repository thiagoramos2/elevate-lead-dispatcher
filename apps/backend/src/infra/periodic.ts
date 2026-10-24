import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';

export interface PeriodicTask {
  /** Para de agendar e espera a iteração em andamento terminar. */
  stop(): Promise<void>;
}

/**
 * Executa `task` para sempre: de novo imediatamente enquanto ela indicar que há mais trabalho,
 * senão depois de `intervalMs`. Erros são logados e nunca derrubam o loop.
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
