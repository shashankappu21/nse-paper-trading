import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  MARKET_DATA_PROVIDER: z.enum(['yahoo', 'fake']).default('yahoo'),
  QUOTE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(15),
  QUOTE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STARTING_CASH: z.coerce.number().positive().default(1_000_000),
  /** sync = execute in-process (Stage 1 / tests); queue = publish to BullMQ */
  EXECUTION_MODE: z.enum(['sync', 'queue']).default('queue'),
  EOD_CRON: z.string().default('0 16 * * 1-5'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
