import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractReferences, followReferences } from "../src/discovery.js";
import { FIXTURES, SAMPLE_REPO } from "./helpers.js";

describe("extractReferences", () => {
  it("finds @imports", () => {
    const refs = extractReferences("See @docs/standards.md for details.\n@other/file.md");
    expect(refs).toContain("docs/standards.md");
    expect(refs).toContain("other/file.md");
  });

  it("finds relative markdown links but not external URLs", () => {
    const text = "[standards](./docs/standards.md) and [site](https://example.com/page.md)";
    const refs = extractReferences(text);
    expect(refs).toEqual(["./docs/standards.md"]);
  });

  it("ignores anchors-only and mailto links", () => {
    expect(extractReferences("[a](#section) [b](mailto:x@y.z)")).toEqual([]);
  });
});

describe("followReferences", () => {
  it("follows an @import out of CLAUDE.md", async () => {
    const root = path.join(SAMPLE_REPO, "CLAUDE.md");
    const text = await readFile(root, "utf8");
    const refs = await followReferences(root, text, SAMPLE_REPO, 3);
    expect(refs.map((r) => path.basename(r.absPath))).toContain("standards.md");
  });

  it("terminates on circular references", async () => {
    const root = path.join(FIXTURES, "cycle", "a.md");
    const text = await readFile(root, "utf8");
    // Project root is the repo root of the fixtures dir so @test/fixtures/... resolves.
    const projectRoot = path.resolve(FIXTURES, "..", "..");
    const refs = await followReferences(root, text, projectRoot, 10);
    // b.md found once, a.md not revisited.
    const names = refs.map((r) => path.basename(r.absPath));
    expect(names).toEqual(["b.md"]);
  });

  it("respects depth 0 (no following)", async () => {
    const root = path.join(SAMPLE_REPO, "CLAUDE.md");
    const text = await readFile(root, "utf8");
    const refs = await followReferences(root, text, SAMPLE_REPO, 0);
    expect(refs).toEqual([]);
  });
});
