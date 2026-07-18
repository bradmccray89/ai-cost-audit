import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

/**
 * Follow local references out of an instruction file:
 *  - Claude Code `@path` imports (line-leading or inline, e.g. `@docs/standards.md`)
 *  - in-repo relative markdown links `[text](./relative/path.md)`
 *
 * Bounded depth with cycle detection. Returns resolved absolute paths of
 * referenced files (deduped), excluding the roots themselves.
 */
export interface ReferencedFile {
  absPath: string;
  referencedFrom: string;
}

const AT_IMPORT_RE = /(?:^|\s)@((?:\.{0,2}\/)?[\w./-]+\.(?:md|txt|json))\b/gm;
const MD_LINK_RE = /\[[^\]]*\]\((?!https?:\/\/|mailto:|#)([^)\s]+?\.(?:md|txt|json))(?:#[^)]*)?\)/g;

export function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(AT_IMPORT_RE)) {
    refs.add(match[1]!);
  }
  for (const match of text.matchAll(MD_LINK_RE)) {
    refs.add(match[1]!);
  }
  return [...refs];
}

export async function followReferences(
  rootFile: string,
  rootText: string,
  projectPath: string,
  maxDepth: number,
  exclude: string[] = [],
): Promise<ReferencedFile[]> {
  const found: ReferencedFile[] = [];
  const visited = new Set<string>([path.resolve(rootFile)]);
  const isExcluded = excludeMatcher(exclude);

  let frontier: { file: string; text: string }[] = [{ file: rootFile, text: rootText }];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: { file: string; text: string }[] = [];
    for (const { file, text } of frontier) {
      for (const ref of extractReferences(text)) {
        const baseDir = path.dirname(file);
        // @foo/bar.md resolves relative to the referencing file; also try project root.
        const candidates = [path.resolve(baseDir, ref), path.resolve(projectPath, ref)];
        const resolved = candidates.find(
          (c) => existsSync(c) && statSync(c).isFile() && insideProject(c, projectPath),
        );
        if (!resolved || visited.has(resolved)) continue;
        if (isExcluded(displayPath(resolved, projectPath))) continue;
        visited.add(resolved);
        try {
          const refText = await readFile(resolved, "utf8");
          found.push({ absPath: resolved, referencedFrom: file });
          next.push({ file: resolved, text: refText });
        } catch {
          // Unreadable file — skip silently; it isn't context if it can't be read.
        }
      }
    }
    frontier = next;
  }

  return found;
}

function insideProject(absPath: string, projectPath: string): boolean {
  const rel = path.relative(path.resolve(projectPath), absPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Repo-relative display path; falls back to absolute for out-of-repo files.
 * Always forward-slash separated, so reports, findings, and committed
 * snapshots are identical across Windows and POSIX machines.
 */
export function displayPath(absPath: string, projectPath: string): string {
  const rel = path.relative(path.resolve(projectPath), absPath);
  return toPosix(rel.startsWith("..") ? absPath : rel);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Matcher over repo-relative posix paths for config.scan.exclude globs. */
export function excludeMatcher(patterns: string[]): (relPath: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }));
  return (relPath) => matchers.some((m) => m(relPath));
}
