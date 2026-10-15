import { test } from "node:test";
import assert from "node:assert/strict";
import { agreement, createAggregator, gpsjamUrl, isFinalGpsjam, judgeDay } from "../src/gpsjam.js";

const CELLS = { baltic: ["841f001ffffffff", "841f003ffffffff"], ctl_london: ["84194adffffffff"] };

test("url for a day", () => {
  assert.equal(gpsjamUrl("2026-10-14"), "https://gpsjam.org/data/2026-10-14-h3_4.csv");
});

test("sums good and bad over each zone's cells, ignoring other cells", () => {
  const agg = createAggregator(CELLS);
  for (const l of [
    "hex,count_good_aircraft,count_bad_aircraft\r",
    "841f001ffffffff,72,47",
    "841f003ffffffff,28,3",
    "84194adffffffff,200,1",
    "8400000ffffffff,5,5",
    "",
  ]) {
    assert.equal(agg.line(l), true);
  }
  assert.deepEqual(agg.result(), {
    ok: true,
    perZone: { baltic: { gj_k: 50, gj_n: 150 }, ctl_london: { gj_k: 1, gj_n: 201 } },
  });
});

test("a changed header stops the parse with FORMAT_CHANGED", () => {
  const agg = createAggregator(CELLS);
  assert.equal(agg.line("h3,good,bad"), false);
  assert.deepEqual(agg.result(), { ok: false, code: "FORMAT_CHANGED" });
  assert.deepEqual(createAggregator(CELLS).result(), { ok: false, code: "EMPTY" });
});

test("more than the byte cap stops the parse with TOO_LARGE", () => {
  const agg = createAggregator(CELLS, { maxBytes: 100 });
  agg.line("hex,count_good_aircraft,count_bad_aircraft");
  let ok = true;
  for (let i = 0; i < 10 && ok; i++) ok = agg.line("8400000ffffffff,5,5");
  assert.equal(ok, false);
  assert.deepEqual(agg.result(), { ok: false, code: "TOO_LARGE" });
});

test("agreement: comparable zone-days, red vs not red, and mean absolute difference", () => {
  const rows = [
    { day: "d1", zone: "baltic", n: 500, pct: 20, gj_n: 900, gj_pct: 30 }, // agree red
    { day: "d2", zone: "baltic", n: 500, pct: 8, gj_n: 900, gj_pct: 12 }, // disagree
    { day: "d3", zone: "baltic", n: 99, pct: 50, gj_n: 900, gj_pct: 50 }, // not comparable: our n
    { day: "d1", zone: "ctl_london", n: 800, pct: 0, gj_n: 49, gj_pct: 0 }, // not comparable: their n
    { day: "d2", zone: "ctl_london", n: 800, pct: 1, gj_n: 400, gj_pct: 0 }, // agree not red
    { day: "d3", zone: "ctl_london", n: 800, pct: 1, gj_n: null, gj_pct: null }, // no gpsjam row
  ];
  const a = agreement(rows.map((r) => ({ ...r, ...judgeDay(r) })));
  assert.deepEqual(a.perZone.baltic, { comparable: 2, agree: 1, mad: 7 });
  assert.deepEqual(a.perZone.ctl_london, { comparable: 1, agree: 1, mad: 1 });
  assert.deepEqual(a.overall, { comparable: 3, agree: 2, mad: 5 });
  assert.deepEqual(agreement([]).overall, { comparable: 0, agree: 0, mad: null });
});

test("judgeDay: comparable only with enough aircraft on both sides; agreement is red vs not red", () => {
  const row = (pct, gj_pct, n = 200, gj_n = 80) => ({ n, pct, gj_n, gj_pct });
  assert.deepEqual(judgeDay(row(12, 30)), { comparable: true, agree: true, diff: 18 });
  assert.deepEqual(judgeDay(row(12, 4)), { comparable: true, agree: false, diff: 8 });
  assert.deepEqual(judgeDay(row(12, 30, 99)), { comparable: false, agree: null, diff: null });
  assert.deepEqual(judgeDay(row(12, null)), { comparable: false, agree: null, diff: null });
  const judged = [{ zone: "baltic", ...row(12, 30) }, { zone: "baltic", ...row(12, 4) }, { zone: "levant", ...row(1, 1, 5) }];
  const a = agreement(judged.map((r) => ({ ...r, ...judgeDay(r) })));
  assert.deepEqual(a.overall, { comparable: 2, agree: 1, mad: 13 });
  assert.deepEqual(a.perZone.levant, { comparable: 0, agree: 0, mad: null });
});

test("a gpsjam day is final once read or refused for its format, size or emptiness; 404s and network errors retry", () => {
  assert.equal(isFinalGpsjam({ ok: true }), true);
  for (const code of ["FORMAT_CHANGED", "TOO_LARGE", "EMPTY"]) assert.equal(isFinalGpsjam({ ok: false, code }), true);
  for (const code of ["not_yet", "http_500", "network"]) assert.equal(isFinalGpsjam({ ok: false, code }), false);
});
