// Settings query hooks (spec 0024).
import { useQuery, useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { SettingsService } from "@/gen/glyph/v1/settings_pb";
import { settingsKeys } from "@/shared/api/keys";

export function useSettings() {
  return useQuery(SettingsService.method.getSettings, {}, { staleTime: 30_000 });
}

/** UpdateSettings, then refetch everything settings-derived. */
export function useUpdateSettings() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatModelId?: string }) =>
      createClient(SettingsService, transport).updateSettings(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.service() }),
  });
}
