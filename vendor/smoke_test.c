/*
 * Does this libsqlite3 actually work on its target architecture?
 *
 * session_demo.ts proves the SESSION round trip, but it needs a Deno built for
 * the same architecture as the library. A cross-compiled aarch64 build has no
 * such Deno on an x86_64 host, so the choice is between shipping an untested
 * binary and having a test that can run under qemu-user. This is that test: the
 * same round trip in C, linked against the library under test, small enough to
 * cross-compile in a second.
 *
 * Built and run by smoke_test.sh. Exits 0 only if every check passes.
 */
#include <stdio.h>
#include <string.h>
#include "sqlite3.h"

static int failures = 0;

static void check(const char *what, int ok) {
  printf("  %s  %s\n", ok ? "PASS" : "FAIL", what);
  if (!ok) failures++;
}

static int rc_ok(const char *what, int rc) {
  if (rc != SQLITE_OK) {
    printf("  FAIL  %s -> rc=%d\n", what, rc);
    failures++;
    return 0;
  }
  return 1;
}

/* Mandatory: sqlite3changeset_apply() refuses a NULL conflict handler. Abort so
 * a conflict is a loud failure rather than a silently dropped row. */
static int on_conflict(void *ctx, int type, sqlite3_changeset_iter *iter) {
  (void)ctx; (void)type; (void)iter;
  return SQLITE_CHANGESET_ABORT;
}

/* "id|title|done;" per row, so two databases can be compared as one string. */
static void dump(sqlite3 *db, char *out, size_t cap) {
  sqlite3_stmt *stmt = 0;
  out[0] = '\0';
  if (sqlite3_prepare_v2(db, "SELECT id,title,done FROM todo ORDER BY id", -1, &stmt, 0)
      != SQLITE_OK) {
    snprintf(out, cap, "<prepare failed: %s>", sqlite3_errmsg(db));
    return;
  }
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    char row[256];
    snprintf(row, sizeof row, "%d|%s|%d;",
             sqlite3_column_int(stmt, 0),
             (const char *)sqlite3_column_text(stmt, 1),
             sqlite3_column_int(stmt, 2));
    strncat(out, row, cap - strlen(out) - 1);
  }
  sqlite3_finalize(stmt);
}

int main(void) {
  const char *schema =
      "CREATE TABLE todo(id INTEGER PRIMARY KEY, title TEXT NOT NULL,"
      " done INTEGER NOT NULL DEFAULT 0);";
  sqlite3 *a = 0, *b = 0;
  sqlite3_session *session = 0;
  void *changeset = 0, *inverse = 0;
  int n_changeset = 0, n_inverse = 0;
  char before[1024], after[1024], replica[1024];

  printf("smoke test: SQLite %s (compiled against %s)\n",
         sqlite3_libversion(), SQLITE_VERSION);

  check("SQLITE_ENABLE_SESSION compiled in",
        sqlite3_compileoption_used("ENABLE_SESSION"));
  check("SQLITE_ENABLE_PREUPDATE_HOOK compiled in (SESSION requires it)",
        sqlite3_compileoption_used("ENABLE_PREUPDATE_HOOK"));

  if (!rc_ok("open A", sqlite3_open(":memory:", &a))) goto done;
  if (!rc_ok("open B", sqlite3_open(":memory:", &b))) goto done;
  if (!rc_ok("schema A", sqlite3_exec(a, schema, 0, 0, 0))) goto done;
  if (!rc_ok("schema B", sqlite3_exec(b, schema, 0, 0, 0))) goto done;
  dump(b, before, sizeof before);

  if (!rc_ok("sqlite3session_create", sqlite3session_create(a, "main", &session))) goto done;
  if (!rc_ok("sqlite3session_attach", sqlite3session_attach(session, "todo"))) goto done;

  if (!rc_ok("mutate A", sqlite3_exec(a,
        "INSERT INTO todo(id,title,done) VALUES(1,'vendor sqlite',0);"
        "INSERT INTO todo(id,title,done) VALUES(2,'probe symbols',0);"
        "INSERT INTO todo(id,title,done) VALUES(3,'delete me',0);"
        "UPDATE todo SET done=1 WHERE id=1;"
        "DELETE FROM todo WHERE id=3;", 0, 0, 0))) goto done;
  dump(a, after, sizeof after);

  if (!rc_ok("sqlite3session_changeset",
             sqlite3session_changeset(session, &n_changeset, &changeset))) goto done;
  printf("  changeset: %d bytes\n", n_changeset);
  check("changeset is non-empty (an empty one means nothing was recorded)",
        n_changeset > 0);

  if (!rc_ok("sqlite3changeset_apply",
             sqlite3changeset_apply(b, n_changeset, changeset, 0, on_conflict, 0))) goto done;
  dump(b, replica, sizeof replica);
  check("B matches A after applying the changeset", strcmp(replica, after) == 0);
  if (strcmp(replica, after) != 0) printf("        A=%s\n        B=%s\n", after, replica);

  if (!rc_ok("sqlite3changeset_invert",
             sqlite3changeset_invert(n_changeset, changeset, &n_inverse, &inverse))) goto done;
  if (!rc_ok("apply inverted changeset",
             sqlite3changeset_apply(b, n_inverse, inverse, 0, on_conflict, 0))) goto done;
  dump(b, replica, sizeof replica);
  check("B is back to its starting state (undo works)", strcmp(replica, before) == 0);

done:
  if (session) sqlite3session_delete(session);
  sqlite3_free(changeset);
  sqlite3_free(inverse);
  if (a) sqlite3_close(a);
  if (b) sqlite3_close(b);
  if (failures) { printf("\n%d check(s) failed\n", failures); return 1; }
  printf("\nall checks passed\n");
  return 0;
}
