import { createProductionApp } from './production.js';

const { app, runtimeConfig } = createProductionApp();

let closing = false;
async function closeGracefully(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await app.close();
}
process.once('SIGINT', () => { void closeGracefully(); });
process.once('SIGTERM', () => { void closeGracefully(); });

await app.listen({ host: runtimeConfig.host, port: runtimeConfig.port });
