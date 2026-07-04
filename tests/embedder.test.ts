import { describe, expect, test } from "bun:test";
import * as Embedder from "../src/embedder.ts";

describe("embedder", () => {
  test("embed returns a vector of default_dim", () => {
    const v = Embedder.embed("hello world");
    expect(Array.isArray(v)).toBe(true);
    expect(v.length).toBe(Embedder.defaultDim());
    for (const x of v) expect(typeof x).toBe("number");
  });

  test("embed honours :dimensions option and clamps", () => {
    expect(Embedder.embed("x", 64).length).toBe(64);
    expect(Embedder.embed("x", 4).length).toBeGreaterThanOrEqual(16);
    expect(Embedder.embed("x", 99_999).length).toBeLessThanOrEqual(4096);
  });

  test("embed is deterministic", () => {
    const a = Embedder.embed("the quick brown fox");
    const b = Embedder.embed("the quick brown fox");
    expect(a).toEqual(b);
  });

  test("embed produces unit-length vectors", () => {
    const v = Embedder.embed("normalization check");
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  });

  test("cosine of identical vectors is ~1", () => {
    const v = Embedder.embed("identical");
    expect(Embedder.cosine(v, v)).toBeCloseTo(1.0, 6);
  });

  test("cosine of length-mismatched vectors is 0", () => {
    expect(Embedder.cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  test("cosine of zeros is 0", () => {
    expect(Embedder.cosine([0, 0], [0, 0])).toBe(0);
  });

  test("similar text scores higher than unrelated text", () => {
    const a = Embedder.embed("PostgreSQL is the database we use");
    const b = Embedder.embed("we use postgres for our database storage");
    const c = Embedder.embed("the weather is nice today");
    expect(Embedder.cosine(a, b)).toBeGreaterThan(Embedder.cosine(a, c));
  });
});