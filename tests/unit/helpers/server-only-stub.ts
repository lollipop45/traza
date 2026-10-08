// Test-only: lets unit tests import TRAZA's server-only modules. In the app, Next.js resolves the
// "server-only" marker itself (it fails the build if such a module reaches a browser bundle); under
// tsx there is no such package, so it resolves to an empty module here. Import this file FIRST.
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// module.registerHooks (Node >= 22.15) is not in @types/node 20 yet.
type ResolveHook = (specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown) => unknown;
const { registerHooks } = nodeModule as unknown as { registerHooks: (hooks: { resolve: ResolveHook }) => void };

const EMPTY = pathToFileURL(path.join(process.cwd(), "tests", "unit", "helpers", "empty-module.cjs")).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
    return next(specifier, context);
  },
});
