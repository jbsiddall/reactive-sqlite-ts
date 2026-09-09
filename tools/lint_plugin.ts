/**
 * Bans TypeScript type assertions. `as` and `<T>x` silence the checker without
 * proving anything; a type predicate, a discriminated union or a narrowing
 * check states the same thing in a way the compiler can verify.
 *
 * `as const` is not an assertion in this sense — it narrows a literal rather
 * than overriding an inference — so it is allowed.
 */
/** The published library: src/ and mod.ts. Suites, examples and vendor tooling are not. */
function isLibrary(filename: string): boolean {
  const path = filename.replaceAll("\\", "/");
  return /(^|\/)src\/[^/]+\.ts$/.test(path) || /(^|\/)mod\.ts$/.test(path);
}

const plugin: Deno.lint.Plugin = {
  name: "project",
  rules: {
    /**
     * `!` is banned in the library, not in the suites. It is a laundered
     * guarantee where types stop holding — at the FFI boundary — and that is a
     * statement about src/. A test asserting the shape of data it built two
     * lines earlier is noise this rule was never aimed at.
     */
    "no-non-null-assertion": {
      create(context) {
        if (!isLibrary(context.filename)) return {};
        return {
          TSNonNullExpression(node) {
            context.report({
              node,
              message: "`!` asserts a guarantee the compiler cannot check",
              hint:
                "Restructure so the narrowing survives — a narrowed const, an early return — or handle the absent case.",
            });
          },
        };
      },
    },

    "no-type-assertion": {
      create(context) {
        const report = (node: Deno.lint.Node, what: string) =>
          context.report({
            node,
            message:
              `${what} silences the type checker without proving anything`,
            hint:
              "Narrow with a type predicate, a discriminated union or a runtime check instead.",
          });
        return {
          TSAsExpression(node) {
            if (
              node.typeAnnotation.type === "TSTypeReference" &&
              node.typeAnnotation.typeName.type === "Identifier" &&
              node.typeAnnotation.typeName.name === "const"
            ) return;
            report(node, "`as`");
          },
          TSTypeAssertion(node) {
            report(node, "An angle-bracket type assertion");
          },
        };
      },
    },
  },
};

export default plugin;
