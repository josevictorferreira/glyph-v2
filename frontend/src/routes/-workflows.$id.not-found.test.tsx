// Audit ticket 2: a deleted/never-existed workflow id must show a friendly
// not-found state with a way back — not a pulsing skeleton forever.
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ConnectError, Code } from "@connectrpc/connect";
import { renderWithApp } from "@test/render";
import type { FakeServices } from "@test/fakeTransport";

const notFound: FakeServices = {
  workflow: {
    getWorkflow: () => Promise.reject(new ConnectError("workflow not found", Code.NotFound)),
  },
  live: {
    watchWorkflow: async function* () {
      await new Promise(() => {});
    },
  },
};

describe("workspace not found", () => {
  it("renders Workflow not found with a link home", async () => {
    renderWithApp(undefined, {
      route: "/workflows/00000000-0000-0000-0000-000000000000",
      services: notFound,
    });
    expect(await screen.findByTestId("workflow-not-found")).toBeInTheDocument();
    expect(screen.getByText("Workflow not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  it("is not retried: the query errors on the first 404", async () => {
    let calls = 0;
    const { queryClient } = renderWithApp(undefined, {
      route: "/workflows/00000000-0000-0000-0000-000000000000",
      services: {
        ...notFound,
        workflow: {
          getWorkflow: () => {
            calls += 1;
            return Promise.reject(new ConnectError("workflow not found", Code.NotFound));
          },
        },
      },
    });
    await screen.findByTestId("workflow-not-found");
    // Let any (wrong) retry attempt land.
    await new Promise((r) => setTimeout(r, 50));
    const cache = queryClient.getQueryCache();
    const errors = cache.getAll().filter((q) => q.state.error);
    expect(errors.length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });
});
