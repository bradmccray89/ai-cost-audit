import { createHash } from "node:crypto";
import type { Config, ContextSource } from "../types.js";
import { countRawTokens } from "../tokenizer.js";

export interface Block {
  sourcePath: string;
  text: string;
  normalized: string;
  tokens: number;
}

export interface DuplicateGroup {
  /** Paths of sources containing the duplicated block (2+). */
  sources: string[];
  /** Tokens wasted = block tokens x (occurrences - 1). */
  redundantTokens: number;
  /** First ~80 chars of the block, for the finding message. */
  excerpt: string;
  exact: boolean;
}

/** Split a source's text into heading/paragraph blocks. */
export function splitBlocks(source: ContextSource, minBlockTokens: number): Block[] {
  // Split on markdown headings and blank-line paragraph boundaries.
  const parts = source.text
    .split(/\r?\n(?=#{1,6}\s)|\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const blocks: Block[] = [];
  for (const text of parts) {
    const normalized = normalize(text);
    if (normalized.length === 0) continue;
    const tokens = countRawTokens(normalized);
    if (tokens < minBlockTokens) continue;
    blocks.push({ sourcePath: source.path, text, normalized, tokens });
  }
  return blocks;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function shingles(normalized: string, k = 3): Set<string> {
  const words = normalized.split(" ");
  const result = new Set<string>();
  if (words.length <= k) {
    result.add(words.join(" "));
    return result;
  }
  for (let i = 0; i <= words.length - k; i++) {
    result.add(words.slice(i, i + k).join(" "));
  }
  return result;
}

/**
 * Overlap (containment) coefficient: intersection / min(|A|, |B|).
 * For near-identical blocks this is the right metric — a copied block with a
 * couple of words changed keeps high containment while Jaccard collapses
 * (each changed word invalidates k shingles on both sides).
 */
function containment(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  const minSize = Math.min(a.size, b.size);
  return minSize === 0 ? 0 : intersection / minSize;
}

/**
 * Detect exact duplicates (normalized hash groups) and near-duplicates
 * (k-shingle containment >= threshold) across all sources' blocks.
 * O(n^2) over blocks — fine at instruction-file scale.
 */
export function findDuplicates(sources: ContextSource[], cfg: Config): DuplicateGroup[] {
  const blocks = sources.flatMap((s) => splitBlocks(s, cfg.duplication.minBlockTokens));
  const groups: DuplicateGroup[] = [];

  // Exact: group by hash of normalized text.
  const byHash = new Map<string, Block[]>();
  for (const block of blocks) {
    const hash = createHash("sha256").update(block.normalized).digest("hex");
    const list = byHash.get(hash);
    if (list) list.push(block);
    else byHash.set(hash, [block]);
  }

  const inExactGroup = new Set<Block>();
  for (const group of byHash.values()) {
    // Only cross-source repetition counts as waste worth flagging.
    const uniquePaths = [...new Set(group.map((b) => b.sourcePath))];
    if (group.length < 2 || uniquePaths.length < 2) continue;
    for (const b of group) inExactGroup.add(b);
    groups.push({
      sources: uniquePaths,
      redundantTokens: group[0]!.tokens * (group.length - 1),
      excerpt: excerpt(group[0]!.text),
      exact: true,
    });
  }

  // Near-dup: pairwise Jaccard over remaining blocks from different sources.
  const remaining = blocks.filter((b) => !inExactGroup.has(b));
  const shingleCache = new Map<Block, Set<string>>();
  const getShingles = (b: Block) => {
    let s = shingleCache.get(b);
    if (!s) {
      s = shingles(b.normalized);
      shingleCache.set(b, s);
    }
    return s;
  };

  const claimed = new Set<Block>();
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i]!;
    if (claimed.has(a)) continue;
    const cluster: Block[] = [a];
    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j]!;
      if (claimed.has(b) || b.sourcePath === a.sourcePath) continue;
      if (containment(getShingles(a), getShingles(b)) >= cfg.duplication.similarityThreshold) {
        cluster.push(b);
      }
    }
    if (cluster.length >= 2) {
      for (const b of cluster) claimed.add(b);
      const minTokens = Math.min(...cluster.map((b) => b.tokens));
      groups.push({
        sources: [...new Set(cluster.map((b) => b.sourcePath))],
        redundantTokens: minTokens * (cluster.length - 1),
        excerpt: excerpt(a.text),
        exact: false,
      });
    }
  }

  return groups.sort((a, b) => b.redundantTokens - a.redundantTokens);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}
