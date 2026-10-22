import { createServer } from 'node:http';
import { loadConfig, rootLogger } from '@nse/core';
import { createApp } from './app';
import { buildContainer } from './container';
import { attachRealtime } from './ws/realtime';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = buildContainer(config);
  const app = createApp(container);
  const server = createServer(app);
  const realtime = attachRealtime(server, container);

  server.listen(config.PORT, () => {
    rootLogger.info({ port: config.PORT, executionMode: config.EXECUTION_MODE, provider: config.MARKET_DATA_PROVIDER }, 'api listening');
  });

  const shutdown = (signal: string) => {
    rootLogger.info({ signal }, 'shutting down');
    void realtime.close();
    server.close(() => {
      void container.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
