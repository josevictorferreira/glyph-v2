import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

// Audit ticket 6: the mobile drawer closes after navigating (picking a
// workflow from it must reveal the destination).
describe("AppShell mobile drawer", () => {
  it("closes the drawer when a link inside it is activated", async () => {
    // Start on a workflow page so the drawer's Home link actually navigates.
    const { router } = renderWithApp(undefined, { route: "/workflows/abc", services });
    expect(router).toBeDefined();
    await screen.findByTestId("canvas");
    fireEvent.click(screen.getByTestId("open-sidebar"));
    // The real user path: activating a link inside the drawer (mouse click or
    // Enter on a focused link — both fire click) navigates and closes it.
    const drawer = screen.getByTestId("app-sidebar-drawer");
    fireEvent.click(within(drawer).getByRole("link", { name: "Home" }));
    await waitFor(() => expect(screen.queryByTestId("app-sidebar-drawer")).not.toBeInTheDocument());
    await waitFor(() => expect(router!.state.location.pathname).toBe("/"));
  });
});
