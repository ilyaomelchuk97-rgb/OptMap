#!/usr/bin/env node
// CLI загрузки дорожного графа.
//
// Примеры:
//   node scripts/ingest.js --synthetic                      # демо-город (Минск, синтетика)
//   node scripts/ingest.js --pbf minsk-city.osm.pbf         # файл с download.geofabrik.de
//   node scripts/ingest.js --xml minsk.osm.xml              # XML-выгрузка (Overpass/JOSM)
//   node scripts/ingest.js --overpass "27.40,53.80,27.70,54.00"  # скачать из Overpass API (bbox: s,w,n,e)
//
// Опции: --out data/graph.json.gz — куда сохранить граф.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

if (args.length === 0 || has('--help')) {
  console.log(`OptMap — загрузка дорожного графа

  node scripts/ingest.js --synthetic [--out data/graph.json.gz]
  node scripts/ingest.js --pbf <файл.osm.pbf> [--out …]      # Geofabrik: https://download.geofabrik.de
  node scripts/ingest.js --xml <файл.osm|.osm.gz> [--out …]  # XML-выгрузка
  node scripts/ingest.js --overpass "s,w,n,e" [--out …]      # скачать дороги по bbox из Overpass API

Совет: для города берите выгрузку города/области (например,
https://download.geofabrik.de/europe/belarus.html или выгрузки gis-lab / overpass).
`);
  process.exit(0);
}

const out = arg('--out', 'data/graph.json.gz');
fs.mkdirSync(path.dirname(out), { recursive: true });

async function main() {
  let graph;
  if (has('--synthetic')) {
    const { generateSyntheticCity } = await import('../server/engine/synthetic.js');
    const t = Date.now();
    graph = generateSyntheticCity();
    console.log(`демо-город сгенерирован за ${Date.now() - t} мс`);
  } else if (arg('--pbf')) {
    const { ingestPbf } = await import('../server/engine/ingest-osm.js');
    graph = await ingestPbf(arg('--pbf'), {
      onProgress: (p) => {
        if (p.phase === 'build') console.log(`сборка графа: ${p.done}/${p.total} путей`);
        else console.log(p.phase, p.ways ?? p.nodes);
      },
    });
  } else if (arg('--xml')) {
    const { ingestXml } = await import('../server/engine/ingest-osm.js');
    graph = await ingestXml(arg('--xml'));
  } else if (arg('--overpass')) {
    const { overpassQuery, ingestOverpassJson } = await import('../server/engine/ingest-osm.js');
    const bbox = arg('--overpass').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
      throw new Error('bbox ожидается в виде "s,w,n,e", например "53.80,27.40,54.00,27.70"');
    }
    const query = overpassQuery(bbox);
    console.log('запрос к Overpass API…');
    const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    let data = null;
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        data = await r.json();
        break;
      } catch (e) {
        console.warn(`${ep}: ${e.message}`);
      }
    }
    if (!data) throw new Error('Overpass API недоступен');
    graph = ingestOverpassJson(data, { sourceName: `Overpass bbox ${bbox.join(',')}` });
  } else {
    throw new Error('Укажите источник: --synthetic | --pbf <файл> | --xml <файл> | --overpass "s,w,n,e"');
  }

  await graph.saveGzip(out);
  console.log(
    `граф: ${graph.nodeCount} узлов, ${graph.edgeCount} рёбер → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} МБ)`
  );
}

main().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
