#!/usr/bin/env node
/**
 * Декодирует КАЖДЫЙ тайл и сообщает о битых.
 *   node tests/check_tiles.js data/tiles
 * Нужны dev-зависимости: npm install
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { VectorTile } = require("@mapbox/vector-tile");
const Pbf = require("pbf");

const root = process.argv[2] || "data/tiles";
let ok = 0;
let bad = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".pbf.gz")) {
      try {
        const raw = zlib.gunzipSync(fs.readFileSync(p));
        const tile = new VectorTile(new Pbf(raw));
        Object.keys(tile.layers).forEach((n) => tile.layers[n].length);
        ok++;
      } catch (err) {
        bad++;
        if (bad <= 5) console.log("БИТЫЙ ТАЙЛ:", p, "—", err.message);
      }
    }
  }
}

if (!fs.existsSync(root)) {
  console.log("Нет тайлов:", root);
  process.exit(1);
}
walk(root);
console.log(`тайлов: ${ok} ок, ${bad} битых`);
process.exit(bad ? 1 : 0);
