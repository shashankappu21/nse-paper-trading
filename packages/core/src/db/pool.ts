import pg from 'pg';
import { getLogger } from '../logger';

// Return BIGINT (count/sum) as number; values in this app stay well within 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Keep DATE as 'YYYY-MM-DD' rather than a timezone-shifted JS Date.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = Pick<pg.Pool, 'query'> | pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => getLogger().error({ err }, 'idle postgres client error'));
  return pool;
}

/** Run fn inside BEGIN/COMMIT; rolls back on any thrown error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
