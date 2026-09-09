/**
 * Bans TypeScript type assertions. `as` and `<T>x` silence the checker without
 * proving anything; a type predicate, a discriminated union or a narrowing
 * check states the same thing in a way the compiler can verify.
 *
 * `as const` is not an assertion in this sense — it narrows a literal rather
 * than overriding an inference — so it is allowed.
 */
const plugin: Deno.lint.Plugin = {
  name: "project",
  rules: {
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
