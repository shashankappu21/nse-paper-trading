import { createPool, migrate, instrumentsRepo, NIFTY_50 } from '../src';

export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://trader:trader@localhost:5432/trading_test';
  const pool = createPool(url, 2);
  try {
    await migrate(pool);
    await instrumentsRepo.upsertMany(pool, NIFTY_50);
  } finally {
    await pool.end();
  }
}
