import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { serverMessage } from "@/lib/error-messages";
import { localTimeZoneId } from "@/lib/local-day";
import { roleNameLabel } from "@/lib/role-labels";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/stores/auth";
import { CreateUserDialog } from "./CreateUserDialog";
import { Search, User, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TeamRoleDto { id: string; name: string; code?: string | null; isSystem: boolean; permissionCodes: string[]; }
interface UserSummaryDto { id: string; username: string; displayName: string; }

export function AssignMemberDialog({ teamId }: { teamId: string }) {
  const { t } = useTranslation(["common", "team"]);
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin;
  const [open, setOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserSummaryDto | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const { data: roles } = useQuery({
    queryKey: ["team-roles", teamId],
    queryFn: async () => (await api.get("/teams/" + teamId + "/roles")).data as TeamRoleDto[],
  });

  // `GET /api/auth/users` 自 2026-09-23 起是**團隊視野**（`X-Team-Id` 那個團隊的成員
  // ∪ 未歸屬使用者；admin 仍看全庫）⇒ 快取 key 必須帶 teamId，否則同時管理兩個團隊的人
  // 切換團隊時會拿到前一個團隊的候選名單（資料還在新鮮期內，不會重取）。
  // 下方兩處 `invalidateQueries({ queryKey: ["all-users"] })` 不必跟著改：react-query
  // 預設前綴比對（`exact: false`），`["all-users"]` 仍命中 `["all-users", teamId]`，
  // 而 `invalidateQueries` 只會重取**作用中**的查詢。
  // `usersResolved` 是「候選名單**已經成功解析**」，與 `usersLoading` 不是同一件事
  // （後者只是「還在飛」）——下方「其他團隊」那一區需要的是前者，見該處的註解。
  const { data: allUsers = [], isLoading: usersLoading, isSuccess: usersResolved } = useQuery({
    queryKey: ["all-users", teamId],
    queryFn: async () => (await api.get("/auth/users")).data as UserSummaryDto[],
    enabled: open,
  });

  const filteredUsers = allUsers.filter((u) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      u.displayName.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q)
    );
  });

  // 300ms debounce：形狀照抄 `SearchModal` 的既有範本（同一個 300ms），不新造。
  // 少了它，每一次按鍵都送一次請求——而後端「至少 3 個字元」那道限制是為了**擋列舉**，
  // 不是省流量，所以這裡 debounce 掉的是「打一次名字送十幾個查詢」的噪音。
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 搜尋**其他團隊**的成員（`GET /api/auth/users/search`；後端是全目錄子字串比對、上限 20 筆）。
  //
  // **查詢 key 刻意不帶 teamId**——與上面 `["all-users", teamId]` 不同。理由：
  // `/auth/users` 的**回應**受 `X-Team-Id` 影響（團隊視野），所以它的 key 必須帶 teamId；
  // 這支端點的回應與團隊無關（永遠是全目錄），`X-Team-Id` 在這裡只影響**授權**
  // （非 admin 要靠它才取得 `team.member.manage` 的判定）。帶了 teamId 不會壞，但會讓
  // 同一個關鍵字在切換團隊時多打一次——那是把一個不存在的相依寫進快取。
  //
  // `enabled` 的 `>= 3` 與後端的最短長度是同一個數字，但兩者角色不同：後端那道是**契約**
  // （`400 request.invalid`，由後端測試守），這一道只是**不讓那個 400 有機會發生**。
  //
  // **`enabled` 刻意不含 `!isAdmin`**（2026-09-24 試過並撤回）：admin 的候選名單本來就是
  // 全庫 ⇒ 這一區對他永遠是空的 ⇒ 看起來「那就不該問」。但把條件放在這裡會讓**渲染端的
  // `showOtherTeams` 失去守門員**——admin 拿不到搜尋資料時，「這一區不渲染」變成由 `enabled`
  // 保證的必然結果，於是那道閘門連自己的突變都變不紅（實測：加進去之後 admin 那支的正對照
  // `client.getQueryData(["user-search","eri"])` 立刻紅）。少問一次請求換掉一道守衛，划不來。
  //
  // **注意**：快取 key 用的是 `searchTerm`（**trim 過**的那個值），不是 `debouncedSearch`：
  // 兩者只在「結尾有空白」時不同，而請求的 URL 走的是 trim 後的值 ⇒ 用未 trim 的值當 key
  // 會讓「erin」與「erin 」（同一個 URL）變成兩筆快取條目與兩次請求，第二次純屬重複。
  // key、`enabled`、URL 三者必須看同一個值——這個變數就是那個值。
  const searchTerm = debouncedSearch.trim();
  const { data: searchResults = [], isLoading: searchLoading, error: searchError } = useQuery({
    queryKey: ["user-search", searchTerm],
    queryFn: async () =>
      (await api.get("/auth/users/search?q=" + encodeURIComponent(searchTerm))).data as UserSummaryDto[],
    enabled: open && searchTerm.length >= 3,
    staleTime: 30_000,
  });

  // 「其他團隊的成員」＝搜尋結果扣掉已經在候選名單裡的人。伺服器**刻意不回**團隊欄位
  // （那會洩漏別隊的組織結構，且與指派無關），所以「這人是不是別隊的」只能在前端推。
  // 兩邊都是 `UserSummaryResponse`，比 `id` 就夠了。
  //
  // **注意**：「扣掉 `allUsers` 剩下的就是第三類」這個推論**依角色而不同**（2026-09-24 修正；
  // 原本這裡寫成無條件成立，那是錯的）：
  //   ① **非 admin**：`/auth/users` 回的是「本團隊 ∪ 未歸屬」（`AuthEndpoints.cs:99-100`
  //      的 `scoped` 成立時才過濾）⇒ 扣掉它剩下的**剛剛好**是兩者皆非的第三類。
  //   ② **admin**：同一處的 `scoped` 帶了 `!= AdminClaim.Value` ⇒ 對 admin 恆為 false，
  //      回應是**全庫** ⇒ `allUsers` 已是所有人的超集，這個 filter **恆為 `[]`**。
  //      於是 admin 底下這一區不是「剛好空」、而是**結構上不可能有內容**：它會把上方候選
  //      清單裡明明看得到的人再報一次「找不到」，自相矛盾的畫面（dev seed 帳號即可重現）。
  // 處置見下方 JSX：admin 直接不渲染這一區。
  const otherTeamResults = searchResults.filter((u) => !allUsers.some((a) => a.id === u.id));

  // 「其他團隊」那一區的顯示前提。寫成一個變數是因為它是**同一個判斷**的兩半，而它同時
  // 決定標題／提示／內容三者的存亡：
  //   ① `!isAdmin`——見上，admin 的候選名單已是全庫，這一區結構上恆空。
  //   ② `usersResolved`——`allUsers` 的預設值是 `[]`，查詢**還在飛或已經失敗**時它也是
  //      `[]`（`data` 沒有值），去重於是什麼都扣不掉，這一區會把**本團隊**的成員列在
  //      「其他團隊的成員」這個標題底下——標題就是假的。選了其實不會壞（`PUT
  //      /teams/{teamId}/members` 是冪等的 diff 指派），所以這是**標籤**問題、不是資料問題。
  //      失敗時連提示也不給：那句提示承諾「打 3 個字元就能搜」，而這一區永遠不會出現。
  const showOtherTeams = !isAdmin && usersResolved;

  const handleSelectUser = (u: UserSummaryDto) => {
    setSelectedUser(u);
    setSearchQuery("");
  };

  const handleClearSelected = () => {
    setSelectedUser(null);
    setSearchQuery("");
  };

  const submit = async () => {
    const targetUsername = selectedUser?.username;
    if (!targetUsername || checked.length === 0) {
      toast.error(t("team:member.assign.required"));
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      // `timeZoneId` 是發起人時區（後端選填；缺漏 ⇒ UTC）：後端用它凍結新成員的到職本地日。
      await api.put("/teams/" + teamId + "/members", { username: targetUsername, roleIds: checked, timeZoneId: localTimeZoneId() });
      await qc.invalidateQueries({ queryKey: ["team", teamId] });
      toast.success(t("team:member.assign.success"));
      setOpen(false);
      setSelectedUser(null);
      setSearchQuery("");
      setChecked([]);
    } catch (error) {
      const detail = isAxiosError(error) ? serverMessage(error.response?.data) : null;
      toast.error(detail ? t("common:error.assignDetail", { detail }) : t("common:error.assign"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">{t("team:member.assign.action")}</Button></DialogTrigger>
      {/* 高度護欄：加了「其他團隊」那一區之後，內容在矮視窗（或筆電放大 125%）會高過
          `DialogContent` 的 `top-[8vh]` 之下可用空間，超出下緣的部分原本是**點不到**的。
          只掛在這個對話框自己的 className 上（`ui/dialog.tsx` 是全站共用的，不動它）。 */}
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("team:member.assign.title")}</DialogTitle></DialogHeader>
        <div className="space-y-4 pt-1">
          {/* 使用者選擇區（篩選下拉） */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t("team:member.assign.select.label")} <span className="text-destructive">*</span></Label>
              {isAdmin && (
                <CreateUserDialog
                  onCreated={(newUser) => {
                    qc.invalidateQueries({ queryKey: ["all-users"] });
                    setSelectedUser({ id: newUser.userId, username: newUser.username, displayName: newUser.displayName });
                  }}
                  trigger={
                    <button type="button" className="text-xs text-primary hover:underline">
                      {t("team:user.create.inline.action")}
                    </button>
                  }
                />
              )}
            </div>

            {selectedUser ? (
              <div className="flex items-center justify-between p-2.5 rounded-lg border bg-primary/5 border-primary/20">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-primary font-semibold text-xs">
                    {selectedUser.displayName.charAt(0) || selectedUser.username.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">{selectedUser.displayName}</div>
                    <div className="text-xs text-muted-foreground">@{selectedUser.username}</div>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={handleClearSelected}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  {t("team:member.select.change.action")}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8 text-sm"
                    placeholder={t("team:member.select.search.placeholder")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="max-h-44 overflow-y-auto rounded-md border bg-popover divide-y divide-border/50">
                  {usersLoading ? (
                    <div className="p-4 text-center text-xs text-muted-foreground">{t("team:member.select.loading")}</div>
                  ) : filteredUsers.length > 0 ? (
                    filteredUsers.map((u) => (
                      <div
                        key={u.id}
                        onClick={() => handleSelectUser(u)}
                        className="flex items-center justify-between p-2.5 hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors text-left"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-medium">
                            <User className="h-3.5 w-3.5" />
                          </div>
                          <div>
                            <div className="text-sm font-medium leading-none">{u.displayName}</div>
                            <div className="text-xs text-muted-foreground mt-1">@{u.username}</div>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 text-center text-xs text-muted-foreground space-y-1.5">
                      <p>{t("team:member.select.noMatch", { query: searchQuery })}</p>
                      {isAdmin && (
                        <CreateUserDialog
                          onCreated={(newUser) => {
                            qc.invalidateQueries({ queryKey: ["all-users"] });
                            setSelectedUser({ id: newUser.userId, username: newUser.username, displayName: newUser.displayName });
                          }}
                          trigger={
                            <Button variant="outline" size="sm" className="text-xs h-7 mt-1">
                              {t("team:user.create.empty.action")}
                            </Button>
                          }
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* 搜尋其他團隊的成員：**既有清單與本地過濾完全不動**，這是多出來的第二段。
                    伺服器的搜尋範圍是全目錄，扣掉上面那份候選名單之後才是「其他團隊」。

                    外層的 `showOtherTeams` 是「這個推論成不成立」（見該處註解：非 admin、
                    且候選名單已成功解析）——不成立時**整區連提示都不出現**，因為那兩句
                    文案都會是假的：標題會蓋住本團隊的人，提示會承諾一個永遠不來的區塊。

                    內層顯示與否看的是 **debounced** 值而不是輸入框的即時值：看即時值的話，
                    打到第 3 個字元的當下這一區就出現，但請求還要 300ms 才會發 ⇒ 那 300ms
                    裡它會先印一次「找不到」（資料還沒到）。看 debounced 值則保證這一區、
                    標題與資料永遠屬於同一次查詢，不會有前一筆查詢的殘影。
                    （兩個條件寫在兩個分支上而不是包一層：包一層要把整段縮排位移，
                    那是本段刻意不動的既有形狀。） */}
                {showOtherTeams && searchTerm.length >= 3 ? (
                  <div className="space-y-1">
                    <div className="px-0.5 text-xs font-medium text-muted-foreground">
                      {t("team:member.search.otherTeams.heading")}
                    </div>
                    <div className="max-h-44 overflow-y-auto rounded-md border bg-popover divide-y divide-border/50">
                      {searchError ? (
                        <div className="p-4 text-center text-xs text-muted-foreground">
                          {apiErrorMessage(searchError, t("common:error.load"))}
                        </div>
                      ) : searchLoading ? (
                        <div className="p-4 text-center text-xs text-muted-foreground">
                          {t("team:member.search.otherTeams.loading")}
                        </div>
                      ) : otherTeamResults.length > 0 ? (
                        otherTeamResults.map((u) => (
                          <div
                            key={u.id}
                            onClick={() => handleSelectUser(u)}
                            className="flex items-center justify-between p-2.5 hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors text-left"
                          >
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-medium">
                                <User className="h-3.5 w-3.5" />
                              </div>
                              <div>
                                <div className="text-sm font-medium leading-none">{u.displayName}</div>
                                <div className="text-xs text-muted-foreground mt-1">@{u.username}</div>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="p-4 text-center text-xs text-muted-foreground">
                          {t("team:member.search.otherTeams.empty")}
                        </div>
                      )}
                    </div>
                  </div>
                ) : showOtherTeams && searchQuery.trim() ? (
                  // 短查詢只給提示、不發請求。提示是**用即時值**判的（不是 debounced）：
                  // 它是「你還沒打夠」的說明，該跟著輸入框走。
                  <p className="px-0.5 text-xs text-muted-foreground">
                    {t("team:member.search.otherTeams.hint")}
                  </p>
                ) : null}
              </div>
            )}
          </div>

          {/* 角色勾選區 */}
          <div className="space-y-1.5 pt-1">
            <Label>{t("team:member.assign.roles.label")} <span className="text-destructive">*</span></Label>
            <div className="grid grid-cols-2 gap-2 p-2.5 rounded-lg border bg-muted/20">
              {(roles ?? []).map((r) => (
                <label
                  key={r.id}
                  className="flex items-center gap-2 text-sm p-1 rounded hover:bg-background/80 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked.includes(r.id)}
                    onChange={(e) =>
                      setChecked((prev) =>
                        e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id))}
                    className="rounded"
                  />
                  <span className="font-medium text-xs">{roleNameLabel(r.code, r.name)}</span>
                  {r.isSystem && <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded">{t("team:role.template.badge")}</span>}
                </label>
              ))}
            </div>
          </div>

          <Button className="w-full" onClick={submit} disabled={submitting || !selectedUser || checked.length === 0}>
            {submitting ? t("common:state.assigning") : t("team:member.assign.confirm.action")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
