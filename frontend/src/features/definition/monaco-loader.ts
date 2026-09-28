// Lazy Monaco + monaco-yaml singleton (spec 0021). Monaco never enters the
// main bundle: every consumer goes through this loader, which configures the
// workers and the workflow schema (same origin as the backend) exactly once.
import type * as Monaco from "monaco-editor";
import type { JSONSchema } from "monaco-yaml";

let loader: Promise<typeof Monaco> | undefined;

export function loadMonaco(): Promise<typeof Monaco> {
  loader ??= (async () => {
    const [monaco, { configureMonacoYaml }, { default: EditorWorker }, { default: YamlWorker }] =
      await Promise.all([
        import("monaco-editor"),
        import("monaco-yaml"),
        import("monaco-editor/editor/editor.worker?worker"),
        import("monaco-yaml/yaml.worker.js?worker"),
      ]);
    self.MonacoEnvironment = {
      getWorker(_workerId, label) {
        return label === "yaml" ? new YamlWorker() : new EditorWorker();
      },
    };
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
