// Lazy Monaco + monaco-yaml singleton (spec 0021). Monaco never enters the
// main bundle: every consumer goes through this loader, which configures the
// workers and the workflow schema (same origin as the backend) exactly once.
import type * as Monaco from "monaco-editor";
import type { JSONSchema } from "monaco-yaml";

let loader: Promise<typeof Monaco> | undefined;

/**
 * monaco-worker-manager 2.x (used by monaco-yaml 5.x) still calls the
 * pre-0.56 `editor.createWebWorker({ moduleId, label, createData })` API.
 * Monaco 0.56+ expects `{ worker, host }`; passing the legacy object makes
 * worker creation throw, Monaco silently falls back to a synchronous local
 * worker without the YAML foreign module, and every language request
 * (`doValidation`, `findLinks`, …) rejects with
 * "Missing requestHandler or method: …" (audit ticket 5).
 *
 * This shim translates the legacy call: it creates the worker for the label
 * itself and replays the two legacy bootstrap messages ("ignore" + createData)
 * that monaco-worker-manager's own worker entry expects before it initializes.
 */
function translateLegacyCreateWebWorker(
  monaco: typeof Monaco,
  workers: { editor: new () => Worker; yaml: new () => Worker },
) {
  const original = monaco.editor.createWebWorker.bind(monaco.editor) as (opts: {
    worker: Worker | Promise<Worker>;
    host?: Record<string, (...args: never[]) => unknown>;
    keepIdleModels?: boolean;
  }) => unknown;
  const patched = (opts: unknown): unknown => {
    const legacy = opts as {
      label?: unknown;
      createData?: unknown;
      host?: unknown;
      keepIdleModels?: unknown;
    };
    if (!("worker" in (opts as object)) && typeof legacy.label === "string") {
      const worker = legacy.label === "yaml" ? new workers.yaml() : new workers.editor();
      // monaco-worker-manager's worker waits for one ignored message before
      // initializing; createData follows it (see `createWebWorker` in
      // monaco-editor/esm/vs/internal/common/workers.js).
      const w = worker as Worker;
      w.postMessage("ignore");
      if (legacy.createData !== undefined) w.postMessage(legacy.createData);
      return original({
        worker: w,
        host: legacy.host as never,
        keepIdleModels: legacy.keepIdleModels as boolean | undefined,
      });
    }
    return original(opts as never);
  };
  monaco.editor.createWebWorker = patched as typeof monaco.editor.createWebWorker;
}

export function loadMonaco(): Promise<typeof Monaco> {
  loader ??= (async () => {
    const [monaco, { configureMonacoYaml }, { default: EditorWorker }, { default: YamlWorker }] =
      await Promise.all([
        import("monaco-editor"),
        import("monaco-yaml"),
        import("monaco-editor/editor/editor.worker?worker"),
        import("monaco-yaml/yaml.worker.js?worker"),
      ]);
    translateLegacyCreateWebWorker(monaco, { editor: EditorWorker, yaml: YamlWorker });
    self.MonacoEnvironment = {
      getWorker(_workerId, label) {
        return label === "yaml" ? new YamlWorker() : new EditorWorker();
      },
    };
    // Base "vs" with accessible line numbers: the default dimmed gutter grays
    // fail WCAG contrast (axe flags dimmed-line-number, spec 0022).
    monaco.editor.defineTheme("glyph", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "editorLineNumber.foreground": "#676770",
        "editorLineNumber.dimmedForeground": "#676770",
        "editorLineNumber.activeForeground": "#1c1c21",
      },
    });
    // The JSON schema is a static asset served by the backend (proxied in
    // dev), not an RPC — a plain same-origin fetch is the right tool here.
    // eslint-disable-next-line no-restricted-globals
    const schema = await fetch("/schemas/workflow.json").then((r) => {
      if (!r.ok) throw new Error(`Failed to load /schemas/workflow.json: ${r.status}`);
      return r.json();
    });
    configureMonacoYaml(monaco, {
      enableSchemaRequest: false,
      hover: true,
      completion: true,
      validate: true,
      // The server owns formatting: apply re-exports to normalize text.
      format: { enable: false },
      schemas: [
        {
          uri: `${location.origin}/schemas/workflow.json`,
          fileMatch: ["*.yml"],
          schema: schema as JSONSchema,
        },
      ],
    });
    return monaco;
  })();
  return loader;
}
