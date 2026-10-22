import type { ExecutionService } from './executionService';

export interface ExecuteOrderJob {
  orderId: string;
  requestId?: string;
  /** Distinguishes a deliberate re-dispatch (reconciler) from the original job id. */
  jobIdSuffix?: string;
}

/** How a validated order reaches execution: in-process (sync) or via BullMQ (queue). */
export interface OrderDispatcher {
  dispatch(job: ExecuteOrderJob): Promise<void>;
}

/** Stage 1 / tests: execute immediately in the same process. */
export class SyncDispatcher implements OrderDispatcher {
  constructor(private readonly execution: ExecutionService) {}

  async dispatch(job: ExecuteOrderJob): Promise<void> {
    await this.execution.executeOrder(job.orderId, job.requestId);
  }
}
