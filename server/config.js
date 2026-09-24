// Конфигурация приложения (переменные окружения / .env)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function int(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : dflt;
}

export const config = {
  port: int('PORT', 8787),
  host: process.env.HOST || '0.0.0.0',

  // Файл дорожного графа. Создаётся скриптом `npm run ingest` (см. README).
  graphPath: process.env.GRAPH_PATH || path.join(__dirname, '..', 'data', 'graph.json.gz'),

  // Свой профиль загрузки дорог (пробок) — JSON с массивами коэффициентов по часам.
  trafficProfilePath: process.env.TRAFFIC_PROFILE || null,

  // Если граф не найден — сгенерировать демо-город (для быстрого старта).
  allowSynthetic: process.env.ALLOW_SYNTHETIC !== 'false',

  // Ограничения API
  maxPoints: int('MAX_POINTS', 50),
  snapRadiusM: int('SNAP_RADIUS_M', 400),

  // Порог отрисовки дорожной сети на клиенте: для больших графов (реальные
  // города) клиент переключается на картографические тайлы.
  mapDataMaxEdges: int('MAP_DATA_MAX_EDGES', 60000),

  tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};
