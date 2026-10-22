import { z } from 'zod';
import { ORDER_SIDES, ORDER_STATUSES, ORDER_TYPES } from './enums';

export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9&-]{1,20}$/, 'Invalid NSE symbol');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(100),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Prices are in rupees with at most 2 decimals; NSE tick size is ₹0.05 for most stocks. */
const priceSchema = z
  .number()
  .positive()
  .max(10_000_000)
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'Price can have at most 2 decimals');

export const placeOrderSchema = z
  .object({
    symbol: symbolSchema,
    side: z.enum(ORDER_SIDES),
    type: z.enum(ORDER_TYPES),
    quantity: z.number().int().positive().max(100_000),
    limitPrice: priceSchema.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.type === 'LIMIT' && o.limitPrice === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['limitPrice'], message: 'limitPrice is required for LIMIT orders' });
    }
    if (o.type === 'MARKET' && o.limitPrice !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['limitPrice'], message: 'limitPrice is not allowed for MARKET orders' });
    }
  });
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key may only contain letters, digits, "-" and "_"');

export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const candlesQuerySchema = z.object({
  range: z.enum(['1M', '3M', '6M', '1Y', '5Y']).default('6M'),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().max(50).default(''),
});

export const quotesQuerySchema = z.object({
  symbols: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(symbolSchema).min(1).max(60)),
});
