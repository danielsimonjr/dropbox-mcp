// Build bundle/index.mjs -- the artifact the Claude Code plugin actually runs.
//
// WHY THIS FILE EXISTS. bundle/index.mjs was committed on 2026-07-02 and nothing in the
// repo recorded how to rebuild it: `bun run build` runs plain `tsc` into dist/, esbuild
// was not a dependency, and no script or workflow mentioned bundle/ at all. The deployed
// artifact was therefore UNREPRODUCIBLE -- a dependency fix could reach bun.lock
// and dist/ while the file the plugin loads kept shipping the old code, with no gate
// objecting because typecheck and the tests both run against src/.
//
// The flags below were recovered from the shipped bundle, not guessed: the esbuild
// `__commonJS`/`__require` helpers identify the bundler, the ESM `createRequire` banner on
// line 2 identifies the format and the shim, and the shebang identifies the entry as a
// bin. Rebuilding with them reproduces a working artifact -- verified by executing it and
// driving a real MCP initialize.
//
// THE BANNER IS LOAD-BEARING, NOT DECORATION. Bundled CommonJS dependencies (the MCP SDK's
// internals among them) reference `require`, `__filename` and `__dirname`, which do not
// exist in an ES module. Without the shim the bundle throws on first use of any of them.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const banner =
  "import { createRequire as __createRequire } from 'node:module';" +
  "import { fileURLToPath as __fileURLToPath } from 'node:url';" +
  "import { dirname as __dirnameOf } from 'node:path';" +
  "const require = __createRequire(import.meta.url);" +
  "const __filename = __fileURLToPath(import.meta.url);" +
  "const __dirname = __dirnameOf(__filename);";

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "bundle", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // NO shebang here. src/index.ts already carries one and esbuild preserves it; adding a
  // second emits it twice, and the duplicate is a syntax error that kills the bundle on
  // startup. Caught by executing the artifact -- a rebuild that merely DIFFERS from the
  // committed file proves nothing, because a stale bundle and a crashing rebuild are the
  // same defect seen from two sides.
  banner: { js: banner },
  // Compile-time version, read from package.json. A hardcoded literal in src makes the
  // running server report a stale version to every client regardless of the manifests --
  // and serverInfo is the ONLY version a client can observe, so a wrong one hides drift
  // from every sweep that compares manifests against each other.
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
});

console.log(`bundled ${pkg.name} ${pkg.version} -> bundle/index.mjs`);
