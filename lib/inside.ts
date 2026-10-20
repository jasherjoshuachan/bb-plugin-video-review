// From bb-plugin-inline-media lib/roots.ts (MIT, same author); see NOTICE.
import path from "node:path";

/** True when `candidate` is strictly inside `directory` (not the directory itself). */
export function isStrictlyInside(directory: string, candidate: string): boolean {
  const root = path.resolve(directory);
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** bb's data folder, derived from this plugin's database path (<dataDir>/plugins/<id>/<file>). */
export function dataDirFromDatabaseName(databaseName: string): string {
  return path.dirname(path.dirname(path.dirname(databaseName)));
}

/** Append one file name to a preview base URL, encoded as a single path segment. */
export function joinPreviewUrl(baseUrl: string, fileName: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileName)}`;
}
