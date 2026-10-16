import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { localTimeZoneId } from "@/lib/local-day";
import { apiErrorMessage } from "@/lib/utils";
import type { ProjectResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectResponse) => void;
}

interface TeamInfo { id: string; name: string; permissions: string[]; }

export function ProjectCreateDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 有 project.create 權限的團隊（#24：單次 bulk 權限請求取代每團隊 1+N）
  const permissions = useQuery({
    queryKey: ["teams-create-perm"],
    queryFn: async () => {
      const list = (await api.get("/teams")).data as { id: string; name: string }[];
      const perms = (await api.get("/teams/my-permissions")).data as { teamId: string; codes: string[] }[];
      const codesByTeam = new Map(perms.map((p) => [p.teamId, p.codes]));
      // 參數名是 `team` 不是 `t`：`t` 是這個元件的翻譯函式（useTranslation），
      // 同名會讓「在這個區塊裡抽字串」變成要等編譯器才發現的陷阱
      // （B2-3／B2-4／B2-5b 各修過同樣的遮蔽，B2-5c 的 review 抓到這兩處）。
      return list
        .filter((team) => (codesByTeam.get(team.id) ?? []).includes("project.create"))
        .map((team) => ({ id: team.id, name: team.name, permissions: codesByTeam.get(team.id) ?? [] }));
    },
    enabled: open,
  });

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t("project:name.required"));
      return;
    }
    if (!teamId) {
      toast.error(t("project:create.team.required"));
      return;
    }
    setSubmitting(true);
    try {
      // `timeZoneId` 是發起人時區（後端選填；缺漏 ⇒ UTC）：後端用它凍結建立者的到職本地日。
      const resp = await api.post("/projects", { name: name.trim(), timeZoneId: localTimeZoneId() }, { headers: { "X-Team-Id": teamId } });
      onCreated(resp.data);
      setName("");
      onOpenChange(false);
    } catch (error) {
      toast.error(apiErrorMessage(error, t("common:error.create")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("project:create.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="project-name">{t("project:name.label")}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("project:create.name.placeholder")} />
          </div>
          <div>
            <Label htmlFor="project-team">{t("project:create.team.label")}</Label>
            <Select
              value={teamId === "" ? "__none__" : teamId}
              onValueChange={(v) => setTeamId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="project-team" className="w-full rounded-md border p-2">
                <SelectValue placeholder={t("common:select.placeholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("common:select.placeholder")}</SelectItem>
                {(permissions.data ?? []).map((team: TeamInfo) => (
                  <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? t("common:state.creating") : t("common:action.create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
