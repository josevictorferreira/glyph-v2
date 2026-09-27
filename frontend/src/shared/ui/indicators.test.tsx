// Indicator component tests (spec 0015).
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionIndicator, SaveIndicator } from "./indicators";
import { renderWithApp } from "@test/render";
import { LiveConnectionIndicator, LiveProvider } from "@/features/live";

describe("SaveIndicator", () => {
  it.each([
    ["idle", "Saved"],
    ["dirty", "Unsaved changes"],
    ["saving", "Saving…"],
    ["saved", "Saved"],
    ["error", "Save failed"],
  ] as const)("renders %s as %s", (status, label) => {
    const { unmount } = renderWithApp(<SaveIndicator status={status} />);
    expect(screen.getByTestId("save-indicator")).toHaveTextContent(label);
    unmount();
  });

  it("offers Retry when saving failed", async () => {
    const onRetry = vi.fn();
    const { unmount } = renderWithApp(<SaveIndicator status="error" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("hides Retry for other statuses", () => {
    const { unmount } = renderWithApp(<SaveIndicator status="saving" onRetry={() => {}} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    unmount();
  });
});

describe("ConnectionIndicator", () => {
  it.each([
    ["connecting", "Connecting…"],
    ["connected", "Live"],
    ["reconnecting", "Reconnecting…"],
    ["offline", "Offline"],
  ] as const)("renders %s as %s", (status, label) => {
    const { unmount } = renderWithApp(<ConnectionIndicator status={status} />);
    expect(screen.getByTestId("connection-indicator")).toHaveTextContent(label);
    unmount();
  });

  it("exposes the label as tooltip", () => {
    const { unmount } = renderWithApp(<ConnectionIndicator status="connected" />);
    expect(screen.getByTestId("connection-indicator")).toHaveAttribute("title", "Live");
    unmount();
  });
});

describe("LiveConnectionIndicator (features/live wiring)", () => {
  it("shows the provider's status", () => {
    const { unmount } = renderWithApp(
      <LiveProvider workflowId="wf">
        <LiveConnectionIndicator />
      </LiveProvider>,
    );
    expect(screen.getByTestId("connection-indicator")).toBeInTheDocument();
    unmount();
  });
});
