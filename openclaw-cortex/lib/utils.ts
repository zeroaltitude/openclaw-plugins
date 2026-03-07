import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Load and parse a JSON file, returning `fallback` on any error.
 */
export function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

/**
 * Save data as pretty-printed JSON, ensuring the parent directory exists.
 */
export function saveJson(path: string, data: unknown, parentDir?: string) {
  if (parentDir) ensureDir(parentDir);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Append an entry to a JSON array file, capping at `maxEntries`.
 */
export function appendToArray(path: string, entry: unknown, maxEntries = 500, parentDir?: string) {
  const arr = loadJson<unknown[]>(path, []);
  arr.push(entry);
  saveJson(path, arr.length > maxEntries ? arr.slice(-maxEntries) : arr, parentDir);
}
