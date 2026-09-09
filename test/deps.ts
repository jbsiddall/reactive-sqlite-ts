/**
 * The one place fast-check's version is written. Deliberately NOT a deno.json
 * import-map entry: the published package must not carry a test dependency,
 * and `publish.exclude` drops test/ wholesale.
 */
export * as fc from "npm:fast-check@4.9.0";

/**
 * Fixed so a run is reproducible; override with FC_SEED to replay a failure.
 * Every property run prints the seed it used.
 */
export const SEED = Number(Deno.env.get("FC_SEED") ?? 20260909);
