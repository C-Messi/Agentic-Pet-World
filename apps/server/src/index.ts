import { buildApp } from './app.js';

const app = buildApp();
const port = Number.parseInt(process.env.PORT ?? '8787', 10);

await app.listen({ host: '127.0.0.1', port });
