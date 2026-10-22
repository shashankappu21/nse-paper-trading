import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  ORDER_QUEUE,
  SCHEDULED_QUEUE,
  getLogger,
  instrumentsRepo,
  runWithContext,
  type EodJobData,
  type EodService,
  type ExecuteOrderJob,
  type ExecutionService,
  type MarketDataService,
  type OrderService,
  type Pool,
} from '@nse/core';

export interface WorkerDeps {
  pool: Pool;
  execution: ExecutionService;
  eod: EodService;
  marketData: MarketDataService;
  orders: OrderService;
}

export interface WorkerOptions {
  connection: ConnectionOptions;
  prefix?: string;
  concurrency?: number;
  /** VALIDATED orders older than this are re-dispatched by the reconciler. */
  staleAfterMs?: number;
}

/**
 * Two consumers:
 *  - order-execution: fills/opens orders the API validated (high concurrency; per-user
 *    serialisation is guaranteed by the row lock inside ExecutionService, not by the queue)
 *  - scheduled: repeatable jobs (EOD close, quote polling, reconciliation), concurrency 1
 */
export function createWorkers(deps: WorkerDeps, opts: WorkerOptions): { workers: Worker[]; close(): Promise<void> } {
  let symbols: string[] | null = null;
  const activeSymbols = async () => (symbols ??= (await instrumentsRepo.listActive(deps.pool)).map((i) => i.symbol));

  const orderWorker = new Worker<ExecuteOrderJob>(
    ORDER_QUEUE,
    (job: Job<ExecuteOrderJob>) =>
      // The API's request id rides on the job so worker logs join up with the API's.
      runWithContext({ requestId: job.data.requestId ?? `job-${job.id}` }, async () => {
        const result = await deps.execution.executeOrder(job.data.orderId, job.data.requestId);
        return { status: result?.status ?? 'MISSING' };
      }),
    { connection: opts.connection, prefix: opts.prefix, concurrency: opts.concurrency ?? 16 },
  );

  const scheduledWorker = new Worker<EodJobData>(
    SCHEDULED_QUEUE,
    (job: Job<EodJobData>) =>
      runWithContext({ requestId: `${job.name}-${job.id}` }, async () => {
        switch (job.name) {
          case 'eod-close':
            return deps.eod.run(job.data?.date);
          case 'quote-poll': {
            const quotes = await deps.marketData.refresh(await activeSymbols(), { publish: true });
            return { quotes: quotes.length };
          }
          case 'reconcile':
            return { redispatched: await deps.orders.redispatchStale(opts.staleAfterMs ?? 30_000) };
          default:
            throw new Error(`Unknown scheduled job ${job.name}`);
        }
      }),
    { connection: opts.connection, prefix: opts.prefix, concurrency: 1 },
  );

  for (const w of [orderWorker, scheduledWorker]) {
    w.on('failed', (job, err) =>
      getLogger().error({ err, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade }, 'job failed'),
    );
    w.on('error', (err) => getLogger().error({ err }, 'worker error'));
  }

  return {
    workers: [orderWorker, scheduledWorker],
    async close() {
      await Promise.all([orderWorker.close(), scheduledWorker.close()]);
    },
  };
}
