// A handful of interactive primitive tests (dialog opens, tabs switch,
// toast fires) to prove the harness.
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@/shared/ui";

describe("primitives", () => {
  it("opens and closes a dialog", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dialog body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("switches tabs", async () => {
    const user = userEvent.setup();
    renderTabs();
    expect(screen.getByText("First")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Two" }));
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("fires toasts imperatively", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderToastButton(onAction);
    await user.click(screen.getByRole("button", { name: "Toast" }));
    expect(await screen.findByText("Run failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View run" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});

import { renderWithApp } from "@test/render";

function renderDialog() {
  renderWithApp(
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open dialog</Button>
      </DialogTrigger>
      <DialogContent title="Confirm">
        <p>Dialog body</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
}

function renderTabs() {
  renderWithApp(
    <Tabs defaultValue="one">
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First</TabsContent>
      <TabsContent value="two">Second</TabsContent>
    </Tabs>,
  );
}

function renderToastButton(onAction: () => void) {
  renderWithApp(
    <Button
      onClick={() =>
        toast({
          title: "Run failed",
          tone: "danger",
          action: { label: "View run", onClick: onAction },
        })
      }
    >
      Toast
    </Button>,
  );
}
