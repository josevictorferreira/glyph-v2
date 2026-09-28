// ESLint: typescript-eslint + react-hooks + architectural boundaries (0013/0014).
//
// Rules enforced here:
//   - shared/* imports nothing from features/*, app or routes (boundaries)
//   - features import other features only through their index.ts (import globs)
//   - only shared/api (and app/providers) construct the transport
//   - components never call fetch directly (plain hrefs for downloads)
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import boundaries from "eslint-plugin-boundaries";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "src/gen",
      "src/routeTree.gen.ts",
      "src/**/*.test.{ts,tsx}",
      "playwright-report",
      "test-results",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    settings: {
      // eslint-plugin-boundaries resolves import paths with the import resolver;
      // the typescript resolver understands the `@/` and `@test/` aliases.
      "import/resolver": {
        typescript: {
          project: "tsconfig.json",
          alwaysTryTypes: true,
        },
      },
      "boundaries/include": ["src/**/*", "test/**/*", "e2e/**/*"],
      "boundaries/elements": [
        { type: "app", pattern: "src/app" },
        { type: "routes", pattern: "src/routes" },
        {
          type: "feature",
          pattern: "src/features/*",
          partialMatch: false,
          capture: ["featureName"],
        },
        { type: "shared", pattern: "src/shared/*", partialMatch: false, capture: ["sharedName"] },
        { type: "gen", pattern: "src/gen" },
        { type: "test", pattern: ["test/*", "e2e/*"], partialMatch: false, capture: ["testKind"] },
      ],
    },
    plugins: { boundaries },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            // shared/* reaches only shared and gen (never features, app, routes).
            {
              from: { element: { type: "shared" } },
              allow: [
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "gen" } } },
              ],
            },
            // features reach shared, gen, app and other features (index only, see globs).
            {
              from: { element: { type: "feature" } },
              allow: [
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "gen" } } },
                { to: { element: { type: "app" } } },
              ],
            },
            {
              from: { element: { type: "app" } },
              allow: [
                { to: { element: { type: "app" } } },
                { to: { element: { type: "routes" } } },
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "gen" } } },
              ],
            },
            {
              from: { element: { type: "routes" } },
              allow: [
                { to: { element: { type: "app" } } },
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "gen" } } },
              ],
            },
            {
              from: { element: { type: "test" } },
              allow: [
                { to: { element: { type: "app" } } },
                { to: { element: { type: "routes" } } },
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "gen" } } },
                { to: { element: { type: "test" } } },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*"],
    ignores: ["src/app/**", "src/shared/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            // 0013: features import other features only through their index.ts.
            {
              group: ["@/features/*/*"],
              message: "Import features through their index.ts (e.g. @/features/canvas).",
            },
            // 0013: only shared/api and app/providers construct the transport.
            {
              group: ["**/shared/api/transport", "@/shared/api/transport"],
              message: "Only shared/api and app/providers construct the transport.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use the gRPC transport (shared/api); downloads are plain hrefs.",
        },
      ],
    },
  },
  {
    // Node scripts run by Playwright (mock servers).
    files: ["e2e/**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  prettier,
);
