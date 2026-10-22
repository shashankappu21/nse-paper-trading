import { createPool, loadConfig, migrate, rootLogger } from '../index';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 2);
  try {
    const applied = await migrate(pool);
    rootLogger.info({ applied }, applied.length ? 'migrations applied' : 'database up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'migration failed');
  process.exit(1);
});
