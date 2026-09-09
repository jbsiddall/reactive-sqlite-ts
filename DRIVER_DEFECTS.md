# Driver defects

Bugs in `@db/sqlite` that this library works around, cannot work around, or
merely runs into. Each one has a minimal reproduction that has been run, so it
is ready to send upstream. Nothing here has been reported yet.

## `openBlob()` on a closed Database segfaults

**Version:** `@db/sqlite` 0.13.0. **Impact:** process death, exit 139, no
JavaScript error.

`Database#close()` frees the `sqlite3*` but leaves the object usable, and
`openBlob()` dereferences the freed handle. No hooks are involved; this is the
driver alone.

```ts
const db = new Database(":memory:");
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
db.exec("INSERT INTO t VALUES (1, zeroblob(8))");
db.close();
db.openBlob({ table: "t", column: "b", row: 1 }); // SIGSEGV
```

While a subscription from this library is attached, the call is intercepted and
throws instead — see the dispose boundary in the README's hard limits. After
`dispose()` the driver's own methods are back and so is the crash.

## Binding `-0` throws

**Version:** `@db/sqlite` 0.13.0. **Impact:** the write never happens, so no
events fire either.

`-0` satisfies the driver's integer test and reaches `sqlite3_bind_int`, which
rejects it.

```ts
db.prepare("INSERT INTO t VALUES (?, ?)").run(1, -0);
// TypeError: Invalid FFI i32 type, expected integer
```

Found by the property suite, which now excludes `-0` from its generators for
this reason.
