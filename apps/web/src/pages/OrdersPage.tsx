import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { OrderDto, OrderStatus } from '@nse/shared';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatINR } from '../lib/format';
import { useToast } from '../lib/toast';
import { Card, Empty, ErrorState, PageLoader, SideTag, Spinner, StatusBadge, Tabs } from '../components/ui';

type Filter = 'ALL' | OrderStatus;

function Timeline({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['order', id], queryFn: () => api.order(id) });
  if (isLoading || !data) return <Spinner className="m-4 h-4 w-4" />;
  return (
    <ol className="space-y-3 border-l border-line py-1 pl-4">
      {data.events.map((e) => (
        <li key={e.id} className="relative text-xs">
          <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand" />
          <span className="font-semibold text-ink-strong">{e.toStatus}</span>
          <span className="ml-2 text-muted">{formatDateTime(e.createdAt)}</span>
          {Object.keys(e.payload).length > 0 && (
            <span className="ml-2 font-mono text-[11px] text-muted">
              {Object.entries(e.payload)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')}
            </span>
          )}
          {e.requestId && <span className="ml-2 font-mono text-[11px] text-muted/70">req {e.requestId.slice(0, 13)}</span>}
        </li>
      ))}
    </ol>
  );
}

function OrderRow({ order }: { order: OrderDto }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(order.id),
    onSuccess: () => {
      toast({ tone: 'info', title: `${order.symbol} order cancelled` });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (err) => toast({ tone: 'error', title: 'Cancel failed', body: err instanceof ApiError ? err.message : undefined }),
  });
  const price = order.fillPrice ?? order.limitPrice;
  return (
    <div className="border-t border-line">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
        className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 hover:bg-canvas sm:grid-cols-[7rem_1fr_6rem_7rem_7rem_6rem]"
      >
        <span className="hidden text-xs text-muted sm:block">{formatDateTime(order.createdAt)}</span>
        <span className="min-w-0">
          <Link onClick={(e) => e.stopPropagation()} to={`/stocks/${encodeURIComponent(order.symbol)}`} className="text-sm font-semibold text-ink-strong hover:text-brand">
            {order.symbol}
          </Link>
          <span className="ml-2">
            <SideTag side={order.side} />
          </span>
          <span className="ml-2 text-xs text-muted">{order.type}</span>
          {order.rejectReason && <span className="block text-xs text-loss">{order.rejectReason.replace(/_/g, ' ').toLowerCase()}</span>}
        </span>
        <span className="num hidden text-right text-sm sm:block">{order.quantity}</span>
        <span className="num hidden text-right text-sm sm:block">{formatINR(price)}</span>
        <span className="text-right">
          <StatusBadge status={order.status} />
        </span>
        <span className="hidden text-right sm:block">
          {order.status === 'OPEN' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                cancel.mutate();
              }}
              disabled={cancel.isPending}
              className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold hover:border-loss hover:text-loss"
            >
              {cancel.isPending ? '…' : 'Cancel'}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="bg-canvas/60 px-6 pb-4 pt-2">
          <p className="mb-2 text-xs text-muted sm:hidden">
            {order.quantity} @ {formatINR(price)} · {formatDateTime(order.createdAt)}
          </p>
          <Timeline id={order.id} />
          {order.status === 'OPEN' && (
            <button onClick={() => cancel.mutate()} className="mt-3 text-xs font-semibold text-loss sm:hidden">
              Cancel order
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function OrdersPage() {
  const [filter, setFilter] = useState<Filter>('ALL');
  const orders = useQuery({ queryKey: ['orders', filter], queryFn: () => api.orders(filter === 'ALL' ? undefined : filter) });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink-strong">Orders</h1>
        <Tabs<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'ALL', label: 'All' },
            { value: 'OPEN', label: 'Open' },
            { value: 'FILLED', label: 'Executed' },
            { value: 'CANCELLED', label: 'Cancelled' },
            { value: 'REJECTED', label: 'Rejected' },
          ]}
        />
      </div>
      {orders.isLoading ? (
        <PageLoader />
      ) : orders.error ? (
        <ErrorState message="Could not load orders." onRetry={() => orders.refetch()} />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[7rem_1fr_6rem_7rem_7rem_6rem] px-4 py-2 text-xs font-medium text-muted sm:grid">
            <span>Time</span>
            <span>Instrument</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Price</span>
            <span className="text-right">Status</span>
            <span />
          </div>
          {orders.data!.length === 0 ? (
            <Empty title="No orders here yet">
              <Link to="/" className="font-semibold text-brand">
                Explore stocks
              </Link>{' '}
              to place your first trade.
            </Empty>
          ) : (
            orders.data!.map((o) => <OrderRow key={o.id} order={o} />)
          )}
        </Card>
      )}
      <p className="text-xs text-muted">Click an order to see its state transitions (PLACED → VALIDATED → OPEN → FILLED).</p>
    </div>
  );
}
