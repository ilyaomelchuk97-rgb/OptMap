// Точка входа OptMap: HTTP-сервер + статика клиентского приложения.

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Engine } from './engine/index.js';
import { createApi } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const engine = await Engine.create(config);
  const app = express();

  app.disable('x-powered-by');
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApi(engine));

  // клиентское приложение
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ошибки API в едином формате
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[optmap] ошибка:', err.message);
    res.status(err.status || 500).json({ error: { message: err.message || 'Внутренняя ошибка' } });
  });

  app.listen(config.port, config.host, () => {
    console.log(`[optmap] сервер: http://${config.host}:${config.port}`);
    console.log(`[optmap] API:   http://${config.host}:${config.port}/api/health`);
  });
}

main().catch((e) => {
  console.error('[optmap] запуск невозможен:', e.message);
  process.exit(1);
});
