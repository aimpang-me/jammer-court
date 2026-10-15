// Module walls that fail the build instead of relying on care (encode lessons in structure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { VERSION } from "../src/version.js";
import { ZONE_CELLS } from "../src/zone_cells.js";
import { ZONES } from "../src/zones.js";

const SRC = new URL("../src/", import.meta.url);
const files = readdirSync(SRC).filter((f) => f.endsWith(".js"));
const read = (f) => readFileSync(new URL(f, SRC), "utf8");
const imports = (f) => [...read(f).matchAll(/from "\.\/([\w.]+)"/g)].map((m) => m[1]);

const IO = ["store.js", "sources.js", "court.js", "index.js"];
const PURE = files.filter((f) => !IO.includes(f)); // a new module is walled by default

test("pure modules import no I/O module", () => {
  for (const f of PURE) for (const i of imports(f)) assert.ok(!IO.includes(i), `${f} imports ${i}`);
});

test("only store.js runs SQL, and only sources.js calls fetch", () => {
  for (const f of files) {
    const src = read(f);
    if (f !== "store.js") assert.ok(!/transactionSync|\.sql\b|\.exec\(/.test(src), `${f} touches SQL`);
    if (f !== "sources.js") assert.ok(!/\bfetch\(/.test(src.replace(/(\.|async )fetch\(/g, "")), `${f} calls fetch`);
  }
});

test("only court.js uses store.js, and the Worker never imports sources.js (only the GitHub sampler fetches upstream)", () => {
  for (const f of files) {
    for (const i of imports(f)) {
      assert.ok(i !== "sources.js", `${f} imports sources.js`);
      if (f !== "court.js") assert.ok(i !== "store.js", `${f} imports store.js`);
    }
  }
});

test("package.json carries the release in src/version.js", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, VERSION);
});

test("zone cells cover exactly the zones in zones.js", () => {
  assert.deepEqual(Object.keys(ZONE_CELLS), ZONES.map((z) => z.id));
  assert.ok(ZONES.every((z) => ZONE_CELLS[z.id].length > 0));
});
