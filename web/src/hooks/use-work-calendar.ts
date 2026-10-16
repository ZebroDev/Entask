import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface WorkCalendarEntry {
  date: string;                        // yyyy-MM-dd，當地日
  kind: "Holiday" | "Workday";
  name: string | null;
}

export function useWorkCalendar(teamId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ["work-calendar", teamId, from, to],
    queryFn: async () =>
      (await api.get(`/teams/${teamId}/work-calendar?from=${from}&to=${to}`))
        .data as WorkCalendarEntry[],
    enabled: !!teamId,
  });
}

// 改日曆會改動所有報表數字（歷史重算，R2）⇒ 除了自己的清單，也把報表相關的查詢作廢。
// 報表那一側的前綴當場讀自 `web/src/pages/reports/WorkLogReport.tsx:43` 的
// queryKey `["worklog", scope, scopeId ?? "", fromIso, toIso]`；TanStack 的
// invalidateQueries 比對的是前綴 ⇒ 只寫 ["worklog"] 就涵蓋全部窗框。
// 就算漏了，切回工作日誌分頁時 Radix 會重新掛載該分頁並重取（staleTime 預設 0）。
export function useUpsertWorkCalendarException(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { date: string; kind: "Holiday" | "Workday"; name: string | null }) =>
      (await api.put(`/teams/${teamId}/work-calendar/${input.date}`, {
        kind: input.kind,
        name: input.name,
      })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["work-calendar", teamId] });
      queryClient.invalidateQueries({ queryKey: ["worklog"] });
    },
  });
}

export function useDeleteWorkCalendarException(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (date: string) =>
      (await api.delete(`/teams/${teamId}/work-calendar/${date}`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["work-calendar", teamId] });
      queryClient.invalidateQueries({ queryKey: ["worklog"] });
    },
  });
}
