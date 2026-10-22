import type { OrderSide, OrderStatus, OrderType, RejectReason, ErrorCode, LedgerReason } from './enums';

/** All money in API responses is in rupees (number with 2 decimals). */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: UserDto;
}

export interface MeResponse {
  user: UserDto;
  cash: number;
}

export interface InstrumentDto {
  symbol: string;
  name: string;
  sector: string;
}

export interface QuoteDto {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  asOf: string;
}

export interface InstrumentWithQuoteDto extends InstrumentDto {
  quote: QuoteDto | null;
}

export interface CandleDto {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderDto {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  status: OrderStatus;
  fillPrice: number | null;
  rejectReason: RejectReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderEventDto {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  payload: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

export interface OrderWithEventsDto extends OrderDto {
  events: OrderEventDto[];
}

export interface HoldingDto {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  investedValue: number;
  lastPrice: number | null;
  currentValue: number | null;
  unrealisedPnl: number | null;
  realisedPnl: number;
}

export interface PortfolioDto {
  cash: number;
  investedValue: number;
  currentValue: number;
  unrealisedPnl: number;
  realisedPnl: number;
  totalValue: number;
  holdings: HoldingDto[];
}

export interface LedgerEntryDto {
  id: string;
  amount: number;
  reason: LedgerReason;
  orderId: string | null;
  createdAt: string;
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** WebSocket protocol */
export type WsClientMessage =
  | { type: 'subscribe'; symbols: string[] }
  | { type: 'unsubscribe'; symbols: string[] };

export type WsServerMessage =
  | { type: 'quote'; data: QuoteDto }
  | { type: 'order'; data: OrderDto }
  | { type: 'error'; message: string };
