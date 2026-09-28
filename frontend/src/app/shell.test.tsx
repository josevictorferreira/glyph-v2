import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { AppShell } from "./shell";
import { renderWithApp } from "@test/render";
import {
  GetWorkflowResponseSchema,
  ListWorkflowsResponseSchema,
  WorkflowSchema,
  WorkflowSummarySchema,
} from "@/gen/glyph/v1/workflow_pb";

const services = {
  workflow: {
    listWorkflows: () => Promise.resolve(create(ListWorkflowsResponseSchema, { workflows: [] })),
    getWorkflow: () =>
      Promise.resolve(
        create(GetWorkflowResponseSchema, {
          workflow: create(WorkflowSchema, {
            summary: create(WorkflowSummarySchema, { id: "abc", name: "Abc" }),
          }),
        }),
      ),
  },
  live: {
    watchWorkflow: async function* () {
      await new Promise(() => {});
    },
  },
};

// 0014 task 5 (updated for 0016): navigating between routes keeps the shell
// mounted; the sidebar is now the library.
describe("AppShell", () => {
  it("renders sidebar and header slots", () => {
    renderWithApp(
      <AppShell sidebar={<div>sidebar-slot</div>} header={<div>header-slot</div>}>
        <div>main-content</div>
      </AppShell>,
    );
    expect(screen.getByTestId("app-sidebar")).toHaveTextContent("sidebar-slot");
    expect(screen.getByTestId("app-header")).toHaveTextContent("header-slot");
    expect(screen.getByTestId("app-main")).toHaveTextContent("main-content");
  });

  it("stays mounted across route navigation", async () => {
    const user = userEvent.setup();
    const { router } = renderWithApp(undefined, { route: "/", services });
    expect(router).toBeDefined();
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();

    await router!.navigate({ to: "/workflows/$id", params: { id: "abc" } });
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(await screen.findByTestId("canvas")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    await screen.findByTestId("home-first-run");
  });
});
