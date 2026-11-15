// Settings page (spec 0024): one field today — the chat agent's model.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  GetSettingsResponseSchema,
  UpdateSettingsResponseSchema,
} from "@/gen/glyph/v1/settings_pb";
import { ListModelsResponseSchema } from "@/gen/glyph/v1/catalog_pb";
import { renderWithApp } from "../../../test/render";
import { SettingsPage } from "./SettingsPage";

let saved: string | undefined;
let failure: ConnectError | undefined;

beforeEach(() => {
  saved = undefined;
  failure = undefined;
});

function services(initial: string | undefined) {
  return {
    settings: {
      getSettings: () =>
        Promise.resolve(create(GetSettingsResponseSchema, { chatModelId: initial })),
      updateSettings: (req: { chatModelId?: string }) => {
        if (failure) return Promise.reject(failure);
        const id = req.chatModelId ?? "";
        saved = id === "" ? undefined : id;
        return Promise.resolve(create(UpdateSettingsResponseSchema, { chatModelId: saved }));
      },
    },
    catalog: {
      listModels: () =>
        Promise.resolve(
          create(ListModelsResponseSchema, {
            models: [
              {
                provider: "velox",
                modelId: "gpt-5",
                fullId: "velox/gpt-5",
                displayName: "GPT-5",
                available: true,
              },
              {
                provider: "velox",
                modelId: "claude-4",
                fullId: "velox/claude-4",
                displayName: "Claude 4",
                available: true,
              },
            ],
          }),
        ),
    },
  } as never;
}

const picker = () => screen.getByRole("button", { name: "Model" });

describe("SettingsPage", () => {
  it("shows the stored model", async () => {
    renderWithApp(<SettingsPage />, { services: services("velox/gpt-5") });
    await waitFor(() => expect(picker()).toHaveTextContent("GPT-5"));
  });

  it("picking another model calls UpdateSettings and shows the saved state", async () => {
    renderWithApp(<SettingsPage />, { services: services("velox/gpt-5") });
    await waitFor(() => expect(picker()).toHaveTextContent("GPT-5"));
    fireEvent.click(picker());
    const option = await screen.findByText("Claude 4");
    fireEvent.click(option);
    await waitFor(() => expect(saved).toBe("velox/claude-4"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("a rejected update shows the server message", async () => {
    failure = new ConnectError(
      "“velox/ghost” is not an available model. Pick one from the list.",
      Code.InvalidArgument,
    );
    renderWithApp(<SettingsPage />, { services: services("velox/gpt-5") });
    await waitFor(() => expect(picker()).toHaveTextContent("GPT-5"));
    fireEvent.click(picker());
    const option = await screen.findByText("Claude 4");
    fireEvent.click(option);
    await waitFor(() =>
      expect(screen.getByText(/is not an available model/)).toBeInTheDocument(),
    );
  });

  it("shows the input-values note", async () => {
    renderWithApp(<SettingsPage />, { services: services(undefined) });
    await waitFor(() =>
      expect(
        screen.getByText(
          "The agent sees workflow input and schedule values, and they are sent to this model's provider.",
        ),
      ).toBeInTheDocument(),
    );
  });
});
