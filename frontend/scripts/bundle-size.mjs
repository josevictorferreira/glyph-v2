#!/usr/bin/env node
// Bundle budget (spec 0022): guards the production build output.
//   1. The main entry chunk must not exceed 850 KB gzip (baseline 819 KB;
//      Monaco lives in lazy chunks that only the definition/import routes load).
//   2. Every emitted JS/CSS chunk must live under dist/assets/ or dist/workers/
//      (anything else would 404 behind the nginx /assets/ cache config).
// Runs after `pnpm build` in `nix run .#check`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, relative } from "node:path";

const dist = new URL("../dist", import.meta.url).pathname;
const BUDGET_BYTES = 850 * 1024;
let failed = false;

// 1. Entry chunk size, gzipped, read from dist/index.html <script src>.
const html = readFileSync(join(dist, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]*src="(\/assets\/[^"]+\.js)"/);
if (!entryMatch) {
  console.error("bundle-size: no entry <script src=\"/assets/…\"> found in dist/index.html");
  process.exit(1);
}
const entryPath = join(dist, entryMatch[1]);
const entryGz = gzipSync(readFileSync(entryPath)).length;
const budgetKb = Math.round(BUDGET_BYTES / 1024);
const entryKb = Math.round(entryGz / 1024);
console.log(`bundle-size: entry ${relative(dist, entryPath)} is ${entryKb} KB gzip (budget ${budgetKb} KB)`);
if (entryGz > BUDGET_BYTES) {
  console.error(
    `bundle-size: FAIL — entry chunk ${entryKb} KB gzip exceeds the ${budgetKb} KB budget`,
  );
  failed = true;
}

// 2. All chunks stay under /assets/ and /workers/. Static assets copied
// from public/ (e.g. theme-init.js) are allowed at the root; bundler-emitted
// chunks are content-hashed (name-AbC12xYz.js) and are not.
const ALLOWED_DIRS = ["assets", "workers"];
const bad = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|css)$/.test(name)) continue;
    const rel = relative(dist, full);
    const top = rel.split(/[\\/]/)[0];
    if (ALLOWED_DIRS.includes(top)) continue;
    // Bundler-emitted chunks are content-hashed (name-ABC123.js); static
    // public/ assets are not.
    const base = name.replace(/\.(js|css)$/, "");
    const hashed = /-[A-Za-z0-9_-]{8,}$/.test(base);
    if (!hashed) continue;
    bad.push(rel);
  }
}
walk(dist);
if (bad.length > 0) {
  console.error(`bundle-size: FAIL — chunks outside dist/assets|workers/:\n  ${bad.join("\n  ")}`);
  failed = true;
}
if (failed) process.exit(1);
console.log("bundle-size: OK");
