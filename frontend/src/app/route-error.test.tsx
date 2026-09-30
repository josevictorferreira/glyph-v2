import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describeRouteError, RouteError } from "./route-error";
import { renderWithApp } from "@test/render";

// 0022 task 4: the root errorComponent renders an app-styled page with a
// Reload button and copyable diagnostics (path, message, stack). Exercised
// through a real router: a route component throws, RouteError catches.
function Throwing() {
  throw new Error("boom while rendering");
}
const rootRoute = createRootRoute({ errorComponent: RouteError });
const crashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$id",
  component: Throwing,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([crashRoute]),
  history: createMemoryHistory({ initialEntries: ["/workflows/abc"] }),
});

describe("RouteError", () => {
  it("renders the path, error message and stack as copyable diagnostics", async () => {
    const user = userEvent.setup();
    renderWithApp(<RouterProvider router={router} />);
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText(/boom while rendering/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toBeInTheDocument();

    await user.click(screen.getByText("Diagnostics"));
    const pre = screen.getByText(/path: \/workflows\/abc/);
    expect(pre).toHaveTextContent(/error: boom while rendering/);
    expect(pre).toHaveTextContent(/stack:/);

    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("path: /workflows/abc"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("error: boom while rendering"));
  });

  it("falls back to the string form for thrown non-Error values", () => {
    expect(describeRouteError("raw string")).toEqual({ message: "raw string" });
    expect(describeRouteError({ weird: 1 })).toEqual({ message: '{"weird":1}' });
    expect(describeRouteError(undefined)).toEqual({ message: "undefined" });
  });
});
