/** Manually trigger the after-close job: `npm run eod -w apps/worker [-- YYYY-MM-DD]`. */
import { createScheduledQueue, loadConfig, rootLogger } from '@nse/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const queue = createScheduledQueue(config.REDIS_URL);
  const date = process.argv[2];
  const job = await queue.add('eod-close', { date }, { attempts: 1 });
  rootLogger.info({ jobId: job.id, date: date ?? 'today' }, 'eod-close job enqueued');
  await queue.close();
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'could not enqueue eod job');
  process.exit(1);
});
