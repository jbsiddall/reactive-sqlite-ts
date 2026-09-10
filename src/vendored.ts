/**
 * Finds the vendored libsqlite3 built for the machine this is running on.
 *
 * The whole point of vendoring is that the driver and our FFI must dlopen the
 * *same file*. The driver decides that at import time from `DENO_SQLITE_PATH`,
 * so this module's job is to set that variable before the driver is imported,
 * and to fail with a message a human can act on when no artifact matches.
 *
 * ```ts
 * import { useVendoredSqlite } from "./src/vendored.ts";
 * const LIB = useVendoredSqlite();          // sets DENO_SQLITE_PATH
 * const { Database } = await import("../driver/mod.ts");   // AFTER, so dynamic
 * ```
 *
 * Needs `--allow-env` and `--allow-read`; the caller needs `--allow-ffi`.
 *
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";

/** A target triple as `build.sh` names its output directories. */
export type Target = string;

/** Raised when there is no vendored artifact for this platform. */
export class NoVendoredLibraryError extends Error {
  override readonly name = "NoVendoredLibraryError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * The `vendor/` directory, reached from `src/` rather than from inside it.
 *
 * The build artifacts stay where `build.sh` writes them; only the code that
 * finds them moved, so this is one level up and back down rather than the
 * directory this file happens to live in.
 */
const VENDOR_DIR = join(
  dirname(dirname(fromFileUrl(import.meta.url))),
  "vendor",
);

/**
 * The target triple for the current process.
 *
 * Linux carries the libc in the triple because a glibc build and a musl build
 * are not interchangeable and dlopen's failure when you mix them is opaque.
 * Deno gives us no libc field, so the triple defaults to `-gnu` and a musl host
 * must say so with `REACTIVE_SQLITE_LIBC=musl`. That is the right way round: the
 * glibc case is the overwhelmingly common one and gets no configuration, and
 * the musl case is a deliberate opt-in rather than a silent mismatch.
 */
export function currentTarget(): Target {
  const os = Deno.build.os;
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  if (os === "linux") {
    const libc = Deno.env.get("REACTIVE_SQLITE_LIBC") ?? "gnu";
    return `linux-${arch}-${libc}`;
  }
  return `${os}-${arch}`;
}

/** The shared-library filename this OS uses. */
export function libraryFileName(
  os: typeof Deno.build.os = Deno.build.os,
): string {
  if (os === "darwin") return "libsqlite3.dylib";
  if (os === "windows") return "sqlite3.dll";
  return "libsqlite3.so";
}

/** Every target directory that currently has a built library. */
export function availableTargets(): Target[] {
  const libRoot = join(VENDOR_DIR, "lib");
  const found: Target[] = [];
  try {
    for (const entry of Deno.readDirSync(libRoot)) {
      if (!entry.isDirectory) continue;
      for (const file of Deno.readDirSync(join(libRoot, entry.name))) {
        if (
          file.name.startsWith("libsqlite3.") || file.name === "sqlite3.dll"
        ) {
          found.push(entry.name);
          break;
        }
      }
    }
  } catch {
    // No lib/ directory at all: an empty list is the honest answer, and
    // vendoredLibraryPath() turns it into the message.
  }
  return found.sort();
}

/**
 * Absolute path to the vendored library for this platform.
 *
 * @throws {NoVendoredLibraryError} when nothing matches. The message names the
 * triple that was looked for, what is actually present, and the two ways out
 * (build it, or point at your own) -- because a bare "not found" from dlopen is
 * exactly the failure this whole exercise exists to eliminate.
 */
export function vendoredLibraryPath(): string {
  const target = currentTarget();
  const path = join(VENDOR_DIR, "lib", target, libraryFileName());
  try {
    if (Deno.statSync(path).isFile) return path;
  } catch {
    // fall through to the diagnostic
  }
  const available = availableTargets();
  throw new NoVendoredLibraryError(
    [
      `No vendored SQLite for this platform.`,
      ``,
      `  wanted:    ${target}  (${Deno.build.os}/${Deno.build.arch})`,
      `  expected:  ${path}`,
      `  available: ${
        available.length ? available.join(", ") : "(none built)"
      }`,
      ``,
      `Fix it one of two ways:`,
      `  1. Build it here:  vendor/build.sh`,
      `     (needs a C compiler and network access; ~1 minute)`,
      `  2. Point at a libsqlite3 you trust:  DENO_SQLITE_PATH=/path/to/libsqlite3.so`,
      `     It must have SQLITE_ENABLE_PREUPDATE_HOOK and SQLITE_ENABLE_SESSION`,
      `     compiled in -- check with: deno task vendor:probe /path/to/libsqlite3.so`,
      ``,
      `On musl (Alpine) set REACTIVE_SQLITE_LIBC=musl so the right artifact is chosen.`,
    ].join("\n"),
  );
}

/**
 * Sets `DENO_SQLITE_PATH` to the vendored library and returns it.
 *
 * An explicit `DENO_SQLITE_PATH` always wins: an operator overriding the
 * library is making a deliberate choice, and silently ignoring it would
 * reintroduce the two-libraries-one-handle crash from the other direction.
 * Call this BEFORE importing the driver, which reads the variable once.
 */
export function useVendoredSqlite(): string {
  const existing = Deno.env.get("DENO_SQLITE_PATH");
  if (existing) return existing;
  const path = vendoredLibraryPath();
  Deno.env.set("DENO_SQLITE_PATH", path);
  return path;
}
