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

/* What the preupdate hook saw. The hook runs on its OWN connection, not on the
 * one the session is attached to: the session extension installs a preupdate
 * hook of its own, and sqlite3_preupdate_hook() holds exactly one callback per
 * connection, so sharing a connection would mean one of the two silently
 * stopped being tested. */
struct preupdate_log {
  int calls, inserts, updates, deletes;
  int columns;     /* sqlite3_preupdate_count() on the last call */
  int depth;       /* sqlite3_preupdate_depth() on the last call */
  int updated_id;  /* sqlite3_preupdate_old(), column 0, on the UPDATE */
  int new_done;    /* sqlite3_preupdate_new(), column 2, on the UPDATE */
};

static void on_preupdate(void *ctx, sqlite3 *db, int op,
                         char const *zDb, char const *zName,
                         sqlite3_int64 key1, sqlite3_int64 key2) {
  struct preupdate_log *log = (struct preupdate_log *)ctx;
  sqlite3_value *v = 0;
  (void)zDb; (void)zName; (void)key1; (void)key2;
  log->calls++;
  if (op == SQLITE_INSERT) log->inserts++;
  if (op == SQLITE_UPDATE) log->updates++;
  if (op == SQLITE_DELETE) log->deletes++;
  log->columns = sqlite3_preupdate_count(db);
  log->depth = sqlite3_preupdate_depth(db);
  if (op == SQLITE_UPDATE) {
    if (sqlite3_preupdate_old(db, 0, &v) == SQLITE_OK && v) log->updated_id = sqlite3_value_int(v);
    v = 0;
    if (sqlite3_preupdate_new(db, 2, &v) == SQLITE_OK && v) log->new_done = sqlite3_value_int(v);
  }
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
  sqlite3 *a = 0, *b = 0, *c = 0, *d = 0;
  sqlite3_session *session = 0;
  void *changeset = 0, *inverse = 0;
  int n_changeset = 0, n_inverse = 0;
  char before[1024], after[1024], replica[1024], restored[1024];
  struct preupdate_log log = {0, 0, 0, 0, -1, -1, -1, -1};
  sqlite3_stmt *q = 0;
  const char *norm = 0;
  sqlite3_int64 image_bytes = 0;
  unsigned char *image = 0;
  sqlite3_int64 nloop = 0;
  int scan_rc = 0;

  printf("smoke test: SQLite %s (compiled against %s)\n",
         sqlite3_libversion(), SQLITE_VERSION);

  /* Printing the two versions is not checking them. A library that is not the
   * one we built -- an rpath that resolved elsewhere, a stale file left in the
   * output directory -- prints its own version here and, before this check
   * existed, went on to exit 0. */
  check("the loaded library is the version we built (" SQLITE_VERSION ")",
        strcmp(sqlite3_libversion(), SQLITE_VERSION) == 0);

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

  /* ---------------------------------------------------------------------
   * The remaining enable-flags, INVOKED rather than queried.
   *
   * sqlite3_compileoption_used() above answers "was the macro defined", which
   * is a question about the build command, not about the library. Every check
   * below calls the symbol the flag exists to provide and asserts on what it
   * returns. That matters most on a cross-compiled artefact, where what can
   * plausibly differ is not whether the file loads but whether the build took
   * our flags.
   * ------------------------------------------------------------------- */

  /* SQLITE_ENABLE_PREUPDATE_HOOK. Its own connection: sqlite3session_create()
   * installs a preupdate hook internally and a connection holds only one, so
   * hooking `a` would silently disable one of the two things being tested. */
  if (!rc_ok("open C", sqlite3_open(":memory:", &c))) goto done;
  if (!rc_ok("schema C", sqlite3_exec(c, schema, 0, 0, 0))) goto done;
  sqlite3_preupdate_hook(c, on_preupdate, &log);
  if (!rc_ok("mutate C", sqlite3_exec(c,
        "INSERT INTO todo(id,title,done) VALUES(1,'vendor sqlite',0);"
        "INSERT INTO todo(id,title,done) VALUES(2,'probe symbols',0);"
        "INSERT INTO todo(id,title,done) VALUES(3,'delete me',0);"
        "UPDATE todo SET done=1 WHERE id=1;"
        "DELETE FROM todo WHERE id=3;", 0, 0, 0))) goto done;
  sqlite3_preupdate_hook(c, 0, 0);
  check("sqlite3_preupdate_hook fired once per row change (3 insert, 1 update, 1 delete)",
        log.calls == 5 && log.inserts == 3 && log.updates == 1 && log.deletes == 1);
  if (log.calls != 5)
    printf("        calls=%d inserts=%d updates=%d deletes=%d\n",
           log.calls, log.inserts, log.updates, log.deletes);
  check("sqlite3_preupdate_count/depth reported the table's 3 columns at depth 0",
        log.columns == 3 && log.depth == 0);
  if (log.columns != 3 || log.depth != 0)
    printf("        count=%d depth=%d\n", log.columns, log.depth);
  check("sqlite3_preupdate_old/new read the row values around the UPDATE",
        log.updated_id == 1 && log.new_done == 1);
  if (log.updated_id != 1 || log.new_done != 1)
    printf("        old id=%d new done=%d\n", log.updated_id, log.new_done);

  /* One prepared statement serves the next three flags. */
  if (!rc_ok("prepare the probe query", sqlite3_prepare_v2(a,
        "SELECT id FROM todo WHERE title='vendor sqlite' AND done=1", -1, &q, 0)))
    goto done;

  /* SQLITE_ENABLE_NORMALIZE */
  norm = sqlite3_normalized_sql(q);
  check("sqlite3_normalized_sql replaced the literals with parameters",
        norm != 0 && strstr(norm, "?") != 0 && strstr(norm, "vendor sqlite") == 0);
  if (!norm || !strstr(norm, "?") || strstr(norm, "vendor sqlite"))
    printf("        normalized=%s\n", norm ? norm : "(null)");

  /* SQLITE_ENABLE_COLUMN_METADATA */
  check("sqlite3_column_{database,table,origin}_name named main.todo.id",
        sqlite3_column_database_name(q, 0) != 0 &&
        strcmp(sqlite3_column_database_name(q, 0), "main") == 0 &&
        sqlite3_column_table_name(q, 0) != 0 &&
        strcmp(sqlite3_column_table_name(q, 0), "todo") == 0 &&
        sqlite3_column_origin_name(q, 0) != 0 &&
        strcmp(sqlite3_column_origin_name(q, 0), "id") == 0);

  while (sqlite3_step(q) == SQLITE_ROW) { /* run it, so there is something to profile */ }

  /* SQLITE_ENABLE_STMT_SCANSTATUS. Only populated after the statement has run,
   * which is what the loop above is for. */
  scan_rc = sqlite3_stmt_scanstatus(q, 0, SQLITE_SCANSTAT_NLOOP, &nloop);
  check("sqlite3_stmt_scanstatus reported at least one loop for the scan",
        scan_rc == 0 && nloop >= 1);
  if (scan_rc != 0 || nloop < 1)
    printf("        rc=%d nloop=%lld\n", scan_rc, (long long)nloop);
  sqlite3_finalize(q);
  q = 0;

  /* SQLITE_ENABLE_DESERIALIZE, both halves: take an image of A and rebuild a
   * fourth database from it, then compare the rows against A's own dump. */
  image = sqlite3_serialize(a, "main", &image_bytes, 0);
  check("sqlite3_serialize produced a non-empty image of A",
        image != 0 && image_bytes > 0);
  if (image != 0 && image_bytes > 0) {
    if (!rc_ok("open D", sqlite3_open(":memory:", &d))) goto done;
    if (!rc_ok("sqlite3_deserialize", sqlite3_deserialize(d, "main", image,
          image_bytes, image_bytes,
          SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE)))
      goto done;
    image = 0; /* FREEONCLOSE: the connection owns it now */
    dump(d, restored, sizeof restored);
    check("the deserialized database has A's rows", strcmp(restored, after) == 0);
    if (strcmp(restored, after) != 0)
      printf("        A=%s\n        D=%s\n", after, restored);
  }

  /* SQLITE_ENABLE_UNLOCK_NOTIFY is NOT invoked here, and that is a stated gap
   * rather than an oversight. sqlite3_unlock_notify() only does anything to a
   * connection that is blocked on SQLITE_LOCKED, which needs shared-cache mode,
   * a second connection holding a table lock, and a deliberate race. Called
   * anywhere else it returns SQLITE_OK and has no observable effect -- a call
   * that cannot fail, which would read as coverage while proving nothing. The
   * symbol is required by build.sh's static check on the stripped library, so
   * its presence is asserted; its behaviour is not. */

done:
  if (session) sqlite3session_delete(session);
  sqlite3_free(changeset);
  sqlite3_free(inverse);
  if (q) sqlite3_finalize(q);
  if (a) sqlite3_close(a);
  if (b) sqlite3_close(b);
  if (c) sqlite3_close(c);
  if (d) sqlite3_close(d);
  if (failures) { printf("\n%d check(s) failed\n", failures); return 1; }
  printf("\nall checks passed\n");
  return 0;
}
