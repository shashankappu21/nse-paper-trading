import type {
  AuthResponse,
  CandleDto,
  ErrorResponse,
  InstrumentWithQuoteDto,
  LedgerEntryDto,
  MeResponse,
  OrderDto,
  OrderStatus,
  OrderWithEventsDto,
  PlaceOrderInput,
  PortfolioDto,
  QuoteDto,
} from '@nse/shared';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function wsUrl(token: string | null): string {
  const base = API_BASE
    ? API_BASE.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  return `${base}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Mirrors the API error envelope so the UI can show the server's message and request id. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;
export function setToken(t: string | null): void {
  token = t;
}
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error. Check your connection and retry.');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as ErrorResponse | null)?.error;
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.requestId, err?.details);
  }
  return { data: body as T, headers: res.headers, status: res.status };
}

const get = async <T>(path: string) => (await request<T>(path)).data;
const post = async <T>(path: string, body?: unknown) =>
  (await request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).data;

export const api = {
  login: (email: string, password: string) => post<AuthResponse>('/auth/login', { email, password }),
  register: (name: string, email: string, password: string) => post<AuthResponse>('/auth/register', { name, email, password }),
  me: () => get<MeResponse>('/auth/me'),

  search: (q: string) => get<InstrumentWithQuoteDto[]>(`/instruments?q=${encodeURIComponent(q)}`),
  top: () => get<{ gainers: InstrumentWithQuoteDto[]; losers: InstrumentWithQuoteDto[]; all: InstrumentWithQuoteDto[] }>('/instruments/top'),
  instrument: (symbol: string) => get<InstrumentWithQuoteDto>(`/instruments/${encodeURIComponent(symbol)}`),
  candles: (symbol: string, range: string) => get<CandleDto[]>(`/instruments/${encodeURIComponent(symbol)}/candles?range=${range}`),
  quotes: (symbols: string[]) => get<Record<string, QuoteDto>>(`/quotes?symbols=${symbols.map(encodeURIComponent).join(',')}`),

  /** The caller owns the idempotency key so a retry of the same click reuses it. */
  placeOrder: async (input: PlaceOrderInput, idempotencyKey: string) => {
    const res = await request<OrderDto>('/orders', { method: 'POST', body: JSON.stringify(input), idempotencyKey });
    return { order: res.data, replayed: res.headers.get('Idempotent-Replayed') === 'true' };
  },
  orders: (status?: OrderStatus) => get<OrderDto[]>(`/orders?limit=200${status ? `&status=${status}` : ''}`),
  order: (id: string) => get<OrderWithEventsDto>(`/orders/${id}`),
  cancelOrder: (id: string) => post<OrderDto>(`/orders/${id}/cancel`),

  portfolio: () => get<PortfolioDto>('/portfolio'),
  ledger: () => get<LedgerEntryDto[]>('/portfolio/ledger'),
};
