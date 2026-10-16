import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import type { BoardSummaryResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LayoutDashboard,
  MoreVertical,
  Pencil,
  Trash2,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { EditBoardDialog } from "../board/EditBoardDialog";
import { DeleteBoardDialog } from "../board/DeleteBoardDialog";
import { useTranslation } from "react-i18next";

interface Props {
  projectId: string;
  canCreateBoard: boolean;
  canReadBoard: boolean;
  canEditBoard?: boolean;
  canDeleteBoard?: boolean;
}

export function BoardListTab({
  projectId,
  canCreateBoard,
  canReadBoard,
  canEditBoard = false,
  canDeleteBoard = false,
}: Props) {
  const { t } = useTranslation(["common", "project"]);
  const [newName, setNewName] = useState("");
  const [editingBoard, setEditingBoard] = useState<BoardSummaryResponse | null>(null);
  const [deletingBoard, setDeletingBoard] = useState<BoardSummaryResponse | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const boards = useQuery({
    queryKey: ["boards", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/boards`)).data as BoardSummaryResponse[],
  });

  const createBoard = useMutation({
    mutationFn: async (name: string) =>
      (await api.post(`/projects/${projectId}/boards`, { name })).data as BoardSummaryResponse,
    onSuccess: (created) => {
      queryClient.setQueryData(["boards", projectId], (old: BoardSummaryResponse[]) => [...(old ?? []), created]);
      setNewName("");
      toast.success(t("project:board.create.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.create"))),
  });

  const toggleArchiveBoard = useMutation({
    mutationFn: async ({ boardId, isArchived }: { boardId: string; isArchived: boolean }) =>
      (await api.put(`/boards/${boardId}`, { isArchived })).data as BoardSummaryResponse,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["boards", projectId] });
      toast.success(variables.isArchived ? t("project:board.archive.success") : t("project:board.unarchive.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.operation"))),
  });

  if (boards.isLoading) return <p className="text-muted-foreground">{t("common:state.loading")}</p>;
  if (boards.isError) {
    const detail = apiErrorMessage(boards.error, t("common:error.tryLater"));
    return <p className="text-destructive">{t("common:error.loadDetail", { detail })}</p>;
  }

  const visible = (boards.data ?? []).filter((b) => !b.isArchived);
  const archived = (boards.data ?? []).filter((b) => b.isArchived);

  return (
    <div>
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((b) => (
          <Card
            key={b.id}
            className={canReadBoard ? "cursor-pointer transition hover:shadow-md relative group" : "relative group"}
            onClick={canReadBoard ? () => navigate(`/projects/${projectId}/boards/${b.id}`) : undefined}
            onKeyDown={
              canReadBoard
                ? (e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    if (e.key === " ") e.preventDefault();
                    navigate(`/projects/${projectId}/boards/${b.id}`);
                  }
                : undefined
            }
            role={canReadBoard ? "button" : undefined}
            tabIndex={canReadBoard ? 0 : undefined}
          >
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <CardTitle className="text-base font-semibold leading-tight pr-2">{b.name}</CardTitle>
              {(canEditBoard || canDeleteBoard) && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 -mr-2 -mt-1 text-muted-foreground hover:text-foreground"
                      >
                        <MoreVertical className="h-4 w-4" />
                        <span className="sr-only">{t("project:board.menu.aria")}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canEditBoard && (
                        <DropdownMenuItem
                          onClick={() => setEditingBoard(b)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          {t("project:board.edit.action")}
                        </DropdownMenuItem>
                      )}
                      {canEditBoard && (
                        <DropdownMenuItem
                          onClick={() =>
                            toggleArchiveBoard.mutate({ boardId: b.id, isArchived: true })
                          }
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          {t("project:board.archive.action")}
                        </DropdownMenuItem>
                      )}
                      {canDeleteBoard && (
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeletingBoard(b)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {t("project:board.delete.action")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {b.description ?? t("project:board.noDescription")}
            </CardContent>
          </Card>
        ))}
        {canCreateBoard && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col gap-2 p-4">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("project:board.create.placeholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim() && !createBoard.isPending) {
                    createBoard.mutate(newName);
                  }
                }}
              />
              <Button disabled={!newName.trim() || createBoard.isPending} onClick={() => createBoard.mutate(newName)}>
                {t("project:board.create.action")}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {visible.length === 0 && !canCreateBoard && (
        <EmptyState
          icon={<LayoutDashboard className="h-7 w-7 text-primary" />}
          title={t("project:board.empty.title")}
          description={t("project:board.empty.description")}
          className="mt-6 py-12"
        />
      )}

      {archived.length > 0 && (
        <details className="mt-6 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
          <summary className="cursor-pointer font-medium hover:text-foreground">
            {t("project:board.archivedSection", { n: archived.length })}
          </summary>
          <div className="mt-3 space-y-2">
            {archived.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded-md border bg-background p-2.5 text-foreground"
              >
                <div>
                  <span className="font-medium">{b.name}</span>
                  {b.description && (
                    <span className="ml-2 text-xs text-muted-foreground">({b.description})</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {canEditBoard && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() =>
                        toggleArchiveBoard.mutate({ boardId: b.id, isArchived: false })
                      }
                    >
                      <ArchiveRestore className="mr-1 h-3.5 w-3.5" />
                      {t("project:board.restore.action")}
                    </Button>
                  )}
                  {canDeleteBoard && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeletingBoard(b)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      {t("common:action.delete")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {editingBoard && (
        <EditBoardDialog
          board={editingBoard}
          open={!!editingBoard}
          onOpenChange={(open) => {
            if (!open) setEditingBoard(null);
          }}
        />
      )}

      {deletingBoard && (
        <DeleteBoardDialog
          board={deletingBoard}
          open={!!deletingBoard}
          onOpenChange={(open) => {
            if (!open) setDeletingBoard(null);
          }}
        />
      )}
    </div>
  );
}
