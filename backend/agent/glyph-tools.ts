/**
 * Glyph agent tools (spec 0024): one Pi extension tool per agent route.
 * Each call is a POST to ${GLYPH_AGENT_API_URL}/agent/v1/<name>; a non-2xx
 * throws, which Pi reports as a failed tool result the model can act on.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE = process.env.GLYPH_AGENT_API_URL!;

interface AgentResponse {
  text: string;
  details?: unknown;
}

async function call(name: string, args: Record<string, unknown>): Promise<AgentResponse> {
  const response = await fetch(`${BASE}/agent/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? "the tool call failed");
  }
  return body as AgentResponse;
}

const workflowId = Type.String({ description: "The workflow id." });

const listWorkflows = defineTool({
  name: "list_workflows",
  label: "List workflows",
  description: "List workflows with their id, name and state.",
  parameters: Type.Object({}),
  async execute(_id, _params) {
    const out = await call("list_workflows", {});
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const getWorkflowYaml = defineTool({
  name: "get_workflow_yaml",
  label: "Get workflow YAML",
  description: "Export a workflow's YAML definition and its fingerprint.",
  parameters: Type.Object({ workflow_id: workflowId }),
  async execute(_id, params) {
    const out = await call("get_workflow_yaml", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const validateYaml = defineTool({
  name: "validate_yaml",
  label: "Validate YAML",
  description: "Dry-run a YAML definition: every error, nothing written.",
  parameters: Type.Object({
    workflow_id: Type.Optional(workflowId),
    yaml: Type.String({ description: "The YAML document." }),
  }),
  async execute(_id, params) {
    const out = await call("validate_yaml", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const updateWorkflow = defineTool({
  name: "update_workflow",
  label: "Update workflow",
  description:
    "Apply an edited YAML definition. Needs the fingerprint from get_workflow_yaml.",
  parameters: Type.Object({
    workflow_id: workflowId,
    yaml: Type.String({ description: "The edited YAML document." }),
    fingerprint: Type.String({ description: "The fingerprint get_workflow_yaml returned." }),
  }),
  async execute(_id, params) {
    const out = await call("update_workflow", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const createWorkflow = defineTool({
  name: "create_workflow",
  label: "Create workflow",
  description: "Create a draft workflow from a YAML definition.",
  parameters: Type.Object({
    yaml: Type.String({ description: "The YAML document." }),
  }),
  async execute(_id, params) {
    const out = await call("create_workflow", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const setWorkflowState = defineTool({
  name: "set_workflow_state",
  label: "Set workflow state",
  description: "Activate, pause or resume a workflow.",
  parameters: Type.Object({
    workflow_id: workflowId,
    action: Type.Union([
      Type.Literal("activate"),
      Type.Literal("pause"),
      Type.Literal("resume"),
    ]),
  }),
  async execute(_id, params) {
    const out = await call("set_workflow_state", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const startRun = defineTool({
  name: "start_run",
  label: "Start run",
  description: "Start a run of a workflow, supplying values by input name.",
  parameters: Type.Object({
    workflow_id: workflowId,
    values: Type.Optional(
      Type.Record(Type.String(), Type.String({ description: "A value." }), {
        description: "Input values by name.",
      }),
    ),
  }),
  async execute(_id, params) {
    const out = await call("start_run", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const getRun = defineTool({
  name: "get_run",
  label: "Get run",
  description: "A run's status and the state of each of its steps.",
  parameters: Type.Object({
    workflow_id: workflowId,
    run_id: Type.String({ description: "The run id." }),
  }),
  async execute(_id, params) {
    const out = await call("get_run", params as Record<string, unknown>);
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const listModels = defineTool({
  name: "list_models",
  label: "List models",
  description: "The valid model_id values for steps.",
  parameters: Type.Object({}),
  async execute() {
    const out = await call("list_models", {});
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

const listTools = defineTool({
  name: "list_tools",
  label: "List tools",
  description: "The tool keys a step may enable.",
  parameters: Type.Object({}),
  async execute() {
    const out = await call("list_tools", {});
    return { content: [{ type: "text", text: out.text }], details: out.details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(listWorkflows);
  pi.registerTool(getWorkflowYaml);
  pi.registerTool(validateYaml);
  pi.registerTool(updateWorkflow);
  pi.registerTool(createWorkflow);
  pi.registerTool(setWorkflowState);
  pi.registerTool(startRun);
  pi.registerTool(getRun);
  pi.registerTool(listModels);
  pi.registerTool(listTools);
}
