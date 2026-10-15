import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csv.ts";
import { team } from "./teams.ts";
import { normalizeName } from "./names.ts";

describe("parseCsv", () => {
  test("quoted fields with commas, escaped quotes and CRLF", () => {
    const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,,NA\r\n');
    assert.deepEqual(rows, [
      { a: "1", b: "x, y", c: 'he said "hi"' },
      { a: "2", b: "", c: "NA" }
    ]);
  });
  test("drops ragged rows and handles a missing trailing newline", () => {
    assert.deepEqual(parseCsv("a,b\n1,2\n3\n4,5"), [{ a: "1", b: "2" }, { a: "4", b: "5" }]);
  });
  test("empty input", () => assert.deepEqual(parseCsv(""), []));
});

describe("team codes", () => {
  test("provider aliases map to one canonical code", () => {
    assert.equal(team("LA"), "LAR");      // nflverse
    assert.equal(team("GBP"), "GB");      // MFL
    assert.equal(team("JAC"), "JAX");
    assert.equal(team("LVR"), "LV");
    assert.equal(team("WSH"), "WAS");     // ESPN-style
    assert.equal(team(" phi "), "PHI");
  });
  test("unknown codes throw instead of mis-scoring", () => {
    assert.throws(() => team("XYZ"), /Unknown NFL team/);
  });
});

describe("normalizeName", () => {
  test("punctuation, suffixes, accents and hyphens", () => {
    assert.equal(normalizeName("D.J. Moore"), normalizeName("DJ Moore"));
    assert.equal(normalizeName("Michael Penix Jr."), "michael penix");
    assert.equal(normalizeName("Kenneth Walker III"), "kenneth walker");
    assert.equal(normalizeName("Jaxon Smith-Njigba"), "jaxon smith njigba");
    assert.equal(normalizeName("Ja'Marr Chase"), "jamarr chase");
    assert.equal(normalizeName("Zoë  Ångström"), "zoe angstrom");
  });
});
