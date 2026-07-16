import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ContextSource, Snapshot } from "./types.js";

export const SNAPSHOT_DIR = ".ai-cost-audit";
export const SNAPSHOT_FILE = "snapshot.json";

/**
 * The snapshot is intended to be committed (lockfile pattern) so CI diffs are
 * meaningful across machines. It is written only via `scan --update-snapshot`.
 */
export function snapshotPath(projectPath: string): string {
  return path.join(projectPath, SNAPSHOT_DIR, SNAPSHOT_FILE);
}

export async function readSnapshot(projectPath: string): Promise<Snapshot | null> {
  const file = snapshotPath(projectPath);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Snapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.sources)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSnapshot(
  projectPath: string,
  sources: ContextSource[],
  gatedBaseline: number,
): Promise<string> {
  const snapshot: Snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    gatedBaseline,
    // Per-source tokens (repo-scoped guaranteed only) so growth attribution works.
    sources: sources
      .filter((s) => s.scope === "repo" && s.usage === "guaranteed")
      .map((s) => ({ path: s.path, tokens: s.tokens }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  const file = snapshotPath(projectPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  return file;
}
