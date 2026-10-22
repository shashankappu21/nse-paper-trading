import type { Queue } from 'bullmq';
import { getLogger, type Config, type EodJobData } from '@nse/core';

/**
 * Repeatable jobs live in Redis as BullMQ job schedulers, so running several worker
 * replicas never runs the EOD job twice (unlike an in-process node-cron in each replica).
 * upsert is idempotent: every worker start re-declares the same schedulers.
 */
export async function registerSchedules(queue: Queue<EodJobData>, config: Config): Promise<void> {
  await queue.upsertJobScheduler(
    'eod-close',
    { pattern: config.EOD_CRON, tz: 'Asia/Kolkata' },
    { name: 'eod-close', data: {}, opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
  );
  await queue.upsertJobScheduler(
    'quote-poll',
    { every: config.QUOTE_POLL_INTERVAL_MS },
    { name: 'quote-poll', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await queue.upsertJobScheduler(
    'reconcile',
    { every: 60_000 },
    { name: 'reconcile', data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } },
  );
  getLogger().info({ eodCron: config.EOD_CRON, pollMs: config.QUOTE_POLL_INTERVAL_MS }, 'job schedulers registered');
}
