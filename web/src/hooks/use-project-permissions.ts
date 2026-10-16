import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useProjectPermissions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-permissions", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/permissions/mine`)).data as string[],
    enabled: !!projectId,
  });
}
