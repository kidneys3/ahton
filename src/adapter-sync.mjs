import fs from "node:fs";
import path from "node:path";

/**
 * Copies the bundled hook adapters into a folder that survives extension
 * updates, so the path written into Claude's settings never names a version.
 * A file is rewritten only when its bytes differ, through a temporary file and
 * a rename, so a failed write leaves the previous copy in place.
 *
 * @param {{sourceDirectory: string, targetDirectory: string, fsApi?: typeof fs}} options
 */
export function syncAdapters({ sourceDirectory, targetDirectory, fsApi = fs }) {
  /** @type {string[]} */
  const copied = [];
  /** @type {string[]} */
  const unchanged = [];
  fsApi.mkdirSync(targetDirectory, { recursive: true });
  for (const name of fsApi.readdirSync(sourceDirectory).filter((entry) => entry.endsWith(".mjs")).sort()) {
    const bytes = fsApi.readFileSync(path.join(sourceDirectory, name));
    const target = path.join(targetDirectory, name);
    let current = null;
    try { current = fsApi.readFileSync(target); } catch { /* absent: copy it */ }
    if (current !== null && current.equals(bytes)) { unchanged.push(name); continue; }
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fsApi.writeFileSync(temporary, bytes);
      fsApi.renameSync(temporary, target);
    } catch (error) {
      fsApi.rmSync(temporary, { force: true });
      throw error;
    }
    copied.push(name);
  }
  return { copied, unchanged };
}
