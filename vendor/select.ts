/**
 * Reads the build manifest `build.sh` leaves beside each vendored library.
 *
 * Choosing the library moved to `src/vendored.ts`, which ships; this is the
 * part only the vendoring tools in this directory read.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { currentTarget } from "../src/vendored.ts";
import type { Target } from "../src/vendored.ts";

/** What `build.sh` writes next to each library. */
export interface BuildManifest {
  sqliteVersion: string;
  sourceUrl: string;
  sourceSha3_256: string;
  sourceSha256: string;
  target: Target;
  libraryFile: string;
  librarySha256: string;
  librarySizeBytes: number;
  compiler: string;
  builtAtUtc: string;
  flags: string[];
}

const VENDOR_DIR = dirname(fromFileUrl(import.meta.url));

/** The manifest beside the library for `target`, or `undefined` if absent. */
export function readManifest(
  target: Target = currentTarget(),
): BuildManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Deno.readTextFileSync(
        join(VENDOR_DIR, "lib", target, "build_manifest.json"),
      ),
    );
    return isBuildManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const STRING_FIELDS = [
  "sqliteVersion",
  "sourceUrl",
  "sourceSha3_256",
  "sourceSha256",
  "target",
  "libraryFile",
  "librarySha256",
  "compiler",
  "builtAtUtc",
] as const;

function isBuildManifest(v: unknown): v is BuildManifest {
  if (v === null || typeof v !== "object") return false;
  if (typeof Reflect.get(v, "librarySizeBytes") !== "number") return false;
  const flags: unknown = Reflect.get(v, "flags");
  if (!Array.isArray(flags) || flags.some((f) => typeof f !== "string")) {
    return false;
  }
  return STRING_FIELDS.every((k) => typeof Reflect.get(v, k) === "string");
}
