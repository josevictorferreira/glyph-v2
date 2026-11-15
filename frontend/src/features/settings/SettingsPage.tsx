// Settings page (spec 0024): one field today — the chat agent's model.
import { useState } from "react";
import { ModelPicker } from "@/features/catalog";
import { useSettings, useUpdateSettings } from "./hooks";

const INPUT_VALUES_NOTE =
  "The agent sees workflow input and schedule values, and they are sent to this model's provider.";

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-ink-subtle" data-testid="settings-page">
        Loading…
      </div>
    );
  }
  const value = data?.chatModelId ?? "";

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="settings-page">
      <h1 className="mb-4 text-lg font-semibold">Settings</h1>
      <div className="max-w-xl space-y-4">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Chat model</p>
          <ModelPicker
            value={value}
            onChange={(fullId) => {
              setSaved(false);
              setError(undefined);
              update.mutate(
                { chatModelId: fullId },
                {
                  onSuccess: () => setSaved(true),
                  onError: (e) => setError(e instanceof Error ? e.message : String(e)),
                },
              );
            }}
          />
          <p className="text-xs text-ink-subtle">{INPUT_VALUES_NOTE}</p>
          {saved && <p className="text-xs text-status-succeeded">Saved</p>}
          {error && (
            <p role="alert" className="text-xs text-status-failed">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
