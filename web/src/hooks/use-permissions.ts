import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";

export function usePermissions() {
  const teamId = useAuth((s) => s.teamId);
  return useQuery({
    queryKey: ["my-permissions", teamId],
    queryFn: async () =>
      (await api.get(`/permissions/mine?teamId=${teamId}`)).data as string[],
    enabled: !!teamId,
  });
}
