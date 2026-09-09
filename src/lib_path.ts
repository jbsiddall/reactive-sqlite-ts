/**
 * Resolves the one libsqlite3 that both `@db/sqlite` and ./hooks.ts must use.
 *
 * @db/sqlite reads DENO_SQLITE_PATH once, at import time, and otherwise
 * downloads its own prebuilt library into $DENO_DIR/plug/. Our FFI must dlopen
 * the same file or the `sqlite3*` we borrow belongs to a different build and
 * the process dies of SIGSEGV. So: import this module BEFORE importing the
 * driver, and pass its return value to `withEvents`.
 */
const CANDIDATES = [
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/libsqlite3.dylib",
];

/**
 * Sets DENO_SQLITE_PATH (unless already set) and returns it. Exits the process
 * with a diagnostic when no system libsqlite3 can be found, because there is
 * nothing useful the caller could do next.
 */
export function resolveLibPath(): string {
  const existing = Deno.env.get("DENO_SQLITE_PATH");
  if (existing) return existing;
  const found = CANDIDATES.find((p) => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      return false;
    }
  });
  if (!found) {
    console.error(
      `No system libsqlite3 found. Set DENO_SQLITE_PATH. Tried:\n  ${
        CANDIDATES.join("\n  ")
      }`,
    );
    Deno.exit(1);
  }
  Deno.env.set("DENO_SQLITE_PATH", found);
  return found;
}
