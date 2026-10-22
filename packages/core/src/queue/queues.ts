import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { ExecuteOrderJob, OrderDispatcher } from '../services/dispatcher';

export const ORDER_QUEUE = 'order-execution';
export const SCHEDULED_QUEUE = 'scheduled';

export type ScheduledJobName = 'eod-close' | 'quote-poll' | 'reconcile';
export interface EodJobData {
  /** IST date to sweep; defaults to today in the worker. */
  date?: string;
}

/** Retry policy for execution jobs. Execution is idempotent, so retries are always safe. */
export const ORDER_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  removeOnComplete: { count: 5_000, age: 24 * 3600 },
  removeOnFail: { count: 10_000 },
};

/** Redis connection settings BullMQ requires (blocking commands must not time out). */
export function bullConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null, enableReadyCheck: false } as ConnectionOptions;
}

/**
 * Publishes validated orders to BullMQ. jobId = orderId deduplicates: if the API retries
 * a dispatch (idempotent replay) while the job is still known to Redis, no second job is created.
 */
export class QueueDispatcher implements OrderDispatcher {
  constructor(private readonly queue: Queue<ExecuteOrderJob>) {}

  async dispatch(job: ExecuteOrderJob): Promise<void> {
    const jobId = job.jobIdSuffix ? `${job.orderId}-${job.jobIdSuffix}` : job.orderId;
    await this.queue.add('execute', { orderId: job.orderId, requestId: job.requestId }, { ...ORDER_JOB_OPTIONS, jobId });
  }
}

export function createOrderQueue(redisUrl: string, prefix?: string): Queue<ExecuteOrderJob> {
  return new Queue<ExecuteOrderJob>(ORDER_QUEUE, { connection: bullConnection(redisUrl), prefix });
}

export function createScheduledQueue(redisUrl: string, prefix?: string): Queue<EodJobData> {
  return new Queue<EodJobData>(SCHEDULED_QUEUE, { connection: bullConnection(redisUrl), prefix });
}
