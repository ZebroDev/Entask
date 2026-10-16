import { useEffect, useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/stores/auth";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { setLocale } from "@/i18n";
import { explicitLocale } from "@/i18n/detect";
import { LOCALE_ENDONYMS, PSEUDO_LOCALE_LABEL, SELECTABLE_PSEUDO_LOCALE, SUPPORTED_LOCALES } from "@/i18n/locales";

interface Preference {
  type: string;
  inAppEnabled: boolean;
}

// 四個通知型態的**識別碼**。這個陣列在模組層級、值在 import 時就算完，
// 所以它只放識別碼——文案由下面的 notificationText 在每次呼叫時求值
// （模組層級算出來的文案會凍結在載入當下的語系，切換語系不會更新，且沒有徵兆）。
//
// id 同時是後端 `/api/notifications/preferences` 的 type 值與 checkbox 的 htmlFor。
const NOTIFICATION_TYPES = ["assigned", "review", "comment", "system"] as const;

/**
 * 通知型態 → 標籤與說明。
 *
 * **寫成 switch 而不是查表，是被 i18next-parser 逼的**——與 `lib/custom-fields.ts`
 * 的 `typeLabel` 同一個理由（該檔有完整說明）。`t(type.labelKey)` 的引數不是字面值，
 * parser 掃不到，而 `i18next-parser.config.js` 的 `keepRemoved: false` 會把
 * 「原始碼裡找不到」的 key 直接從語系檔刪掉——畫面只會顯示 key 本身，
 * 沒有錯誤、沒有警告、測試也不會紅。
 *
 * B2-2b 實測：查表版本會被 CI 的 `--fail-on-update` 判為「這 8 條沒人用」而刪除。
 * 型態不認得時退回顯示 id，讓它在畫面上看得見而不是靜默。
 */
const notificationText = (t: TFunction<["common", "me"]>, id: string) => {
  switch (id) {
    case "assigned":
      return {
        label: t("me:notification.assigned.label"),
        description: t("me:notification.assigned.description"),
      };
    case "review":
      return {
        label: t("me:notification.review.label"),
        description: t("me:notification.review.description"),
      };
    case "comment":
      return {
        label: t("me:notification.comment.label"),
        description: t("me:notification.comment.description"),
      };
    case "system":
      return {
        label: t("me:notification.system.label"),
        description: t("me:notification.system.description"),
      };
    default:
      return { label: id, description: "" };
  }
};

export function UserSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["common", "me"]);
  const { user, updateProfile } = useAuth();
  
  // Notification States
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingNotif, setSavingNotif] = useState(false);

  // Profile States
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [savingProfile, setSavingProfile] = useState(false);
  
  // Password States
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  
  // Avatar States
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // Language State。「跟隨瀏覽器」與「明確指定」是**兩個狀態**（R6），以
  // 「localStorage 有沒有 LOCALE_STORAGE_KEY」編碼——所以這裡存的是「選了什麼」，
  // 不是「現在是什麼」。`null` 代表跟隨瀏覽器，不是「還沒決定」也不是空字串。
  // 不從 `i18n.resolvedLanguage` 推：那只知道現在解析成什麼，分不出「選了 en」
  // 與「瀏覽器是 en 而使用者選了跟隨瀏覽器」——而選單必須把這兩者畫得不一樣。
  // 認不得的值一律視為「跟隨瀏覽器」。可達路徑：dev 在 localhost:5173 選了偽語系，
  // 同一個 origin 換成 release 建置（`PSEUDO_LOCALE_LABEL` 被常數折疊折掉、選項
  // 消失），或鍵被手改。留著它的話**沒有任何 radio 是選中的**——選單看起來是空的。
  const [localeChoice, setLocaleChoice] = useState<string | null>(() => {
    const stored = explicitLocale();
    if (stored === null) return null;
    return stored === SELECTABLE_PSEUDO_LOCALE || SUPPORTED_LOCALES.includes(stored) ? stored : null;
  });

  const handleLocaleChange = (value: string | null) => {
    setLocaleChoice(value);
    // setLocale(null) 會**刪除** localStorage 鍵（不是存 "null"）。不 await：
    // 畫面靠 state 立即回饋，語系切換完成時 i18n 會自行通知所有訂閱者重繪
    // （LanguageBoundary 在 App 之上，見 AGENTS.md 的不變量）。
    void setLocale(value);
  };

  // 初始化表單**只該在對話框開啟的那一刻**跑一次（B2-7 review M1）。
  //
  // 相依原本是 `[open, user, t]`，而其中兩個都會在對話框**開著的時候**無聲變動：
  // react-i18next 的 `t` 在 languageChanged 時會換身分（`useTranslation` 重新
  // `getFixedT`），`updateProfile` 也會換掉 `user` 的身分（上傳頭像走這條）。
  // 兩者都會讓 effect 重跑，把使用者**未送出的**顯示名稱與密碼清掉——而語系選單
  // 就在同一個對話框裡，所以「換語系 → 表單被重設」現在可從 UI 觸發。
  //
  // 用 ref 記「這一輪開啟是否已初始化過」：這個 effect 的語意是「開啟」這個**邊緣**，
  // 不是「open／user／t 的任一組合」。`!user` 時不設旗標，等 user 到位才初始化。
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (!user || initialized.current) return;
    initialized.current = true;

    setDisplayName(user.displayName);
    setCurrentPassword("");
    setNewPassword("");

    setLoading(true);
    api.get("/notifications/preferences")
      .then((res: any) => setPreferences(res.data))
      .catch((_err: any) => toast.error(t("me:preferences.loadError")))
      .finally(() => setLoading(false));
    // 相依**刻意留著 `t` 與 `user`**：它們確實被這個 closure 讀取，拿掉只是把
    // 一個真的存在的相依藏起來（lint 也會正確地抱怨）。會重跑沒關係——上面的
    // `initialized` 才是「要不要重設表單」的判準，重跑會在第一個 if 就返回。
  }, [open, user, t]);

  const handleSaveNotifications = async () => {
    setSavingNotif(true);
    try {
      await api.put("/notifications/preferences", preferences);
      toast.success(t("me:preferences.saved"));
    } catch (error) {
      toast.error(t("common:error.save"));
    } finally {
      setSavingNotif(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!displayName.trim()) return toast.error(t("me:profile.displayName.required"));
    setSavingProfile(true);
    try {
      await api.put("/me/profile", { displayName });
      updateProfile({ displayName });
      toast.success(t("me:profile.updated"));
    } catch (error: any) {
      toast.error(t("me:profile.updateError"));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSavePassword = async () => {
    if (!currentPassword || !newPassword) return toast.error(t("me:password.bothRequired"));
    setSavingPassword(true);
    try {
      await api.put("/me/password", { currentPassword, newPassword });
      toast.success(t("me:password.updated"));
      setCurrentPassword("");
      setNewPassword("");
    } catch (error: any) {
      toast.error(apiErrorMessage(error, t("me:password.updateError")));
    } finally {
      setSavingPassword(false);
    }
  };
  
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setUploadingAvatar(true);
    const formData = new FormData();
    formData.append("file", file);
    
    try {
      const res = await api.put("/me/avatar", formData);
      updateProfile({ avatarUrl: res.data.avatarUrl });
      toast.success(t("me:avatar.updated"));
    } catch (error) {
      toast.error(t("me:avatar.updateError"));
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
  
  const handleAvatarRemove = async () => {
    setUploadingAvatar(true);
    try {
      await api.delete("/me/avatar");
      updateProfile({ avatarUrl: undefined });
      toast.success(t("me:avatar.removed"));
    } catch (error) {
      toast.error(t("me:avatar.removeError"));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleToggle = (type: string, enabled: boolean) => {
    setPreferences(prev => {
      const existing = prev.find(p => p.type === type);
      if (existing) {
        return prev.map(p => p.type === type ? { ...p, inAppEnabled: enabled } : p);
      }
      return [...prev, { type, inAppEnabled: enabled }];
    });
  };

  const isEnabled = (type: string) => {
    const pref = preferences.find(p => p.type === type);
    return pref ? pref.inAppEnabled : true;
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>{t("common:nav.userSettings")}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="account" className="mt-2">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="account">{t("me:settings.tab.account")}</TabsTrigger>
            <TabsTrigger value="notifications">{t("me:settings.tab.notifications")}</TabsTrigger>
            <TabsTrigger value="language">{t("me:settings.tab.language")}</TabsTrigger>
          </TabsList>

          <TabsContent value="account" className="space-y-4 pt-4">
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  {user.avatarUrl ? (
                    <AvatarImage src={user.avatarUrl} alt={user.displayName} />
                  ) : (
                    <AvatarFallback className="text-xl">
                      {user.displayName?.charAt(0) || user.username.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  )}
                </Avatar>
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingAvatar}>
                      {uploadingAvatar ? t("common:state.uploading") : t("me:avatar.upload.action")}
                    </Button>
                    {user.avatarUrl && (
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={handleAvatarRemove} disabled={uploadingAvatar}>
                        {t("common:action.remove")}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("me:avatar.upload.hint")}</p>
                  <input type="file" className="hidden" ref={fileInputRef} accept=".jpg,.jpeg,.png,.gif,.webp" onChange={handleAvatarUpload} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("me:profile.displayName.label")}</Label>
                <div className="flex gap-2">
                  <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
                  <Button onClick={handleSaveProfile} disabled={savingProfile}>
                    {savingProfile ? t("common:state.updating") : t("common:action.update")}
                  </Button>
                </div>
              </div>
              
              <div className="space-y-2 pt-2 border-t">
                <Label>{t("me:password.change.label")}</Label>
                <Input type="password" placeholder={t("me:password.current.placeholder")} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
                <div className="flex gap-2 mt-2">
                  <Input type="password" placeholder={t("me:password.new.placeholder")} value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                  <Button onClick={handleSavePassword} disabled={savingPassword}>
                    {savingPassword ? t("common:state.updating") : t("me:password.change.action")}
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>
          
          <TabsContent value="notifications" className="space-y-4 pt-4">
            {loading ? (
              <div className="text-sm text-muted-foreground">{t("common:state.loading")}</div>
            ) : (
              <div className="space-y-4">
                {NOTIFICATION_TYPES.map((id) => {
                  const { label, description } = notificationText(t, id);
                  return (
                    <div key={id} className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor={`notif-${id}`}>{label}</Label>
                        <p className="text-xs text-muted-foreground">
                          {description}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        id={`notif-${id}`}
                        className="h-4 w-4"
                        checked={isEnabled(id)}
                        onChange={(e) => handleToggle(id, e.target.checked)}
                      />
                    </div>
                  );
                })}
                
                <div className="flex justify-end pt-2">
                  <Button onClick={handleSaveNotifications} disabled={savingNotif}>
                    {savingNotif ? t("common:state.saving") : t("me:preferences.save.action")}
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="language" className="space-y-4 pt-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("me:settings.language.label")}</legend>
              <LocaleOption
                checked={localeChoice === null}
                label={t("me:settings.language.browser")}
                onSelect={() => handleLocaleChange(null)}
              />
              {SUPPORTED_LOCALES.map((code) => (
                <LocaleOption
                  key={code}
                  checked={localeChoice === code}
                  label={LOCALE_ENDONYMS[code] ?? code}
                  onSelect={() => handleLocaleChange(code)}
                />
              ))}
              {PSEUDO_LOCALE_LABEL !== null && (
                <LocaleOption
                  // 比較的對象必須是**可為 null 的**常數，不能是 PSEUDO_LOCALE：
                  // `localeChoice === PSEUDO_LOCALE` 是折疊折不掉的參考，`en-XA` 會進
                  // release bundle（B2-7 review 的 L5 就是這樣踩到的，而它只有手動的
                  // bundle 掃描看得到——掃描不是閘門）。
                  checked={localeChoice === SELECTABLE_PSEUDO_LOCALE}
                  label={PSEUDO_LOCALE_LABEL}
                  onSelect={() => handleLocaleChange(SELECTABLE_PSEUDO_LOCALE)}
                />
              )}
            </fieldset>
            <p className="text-xs text-muted-foreground">{t("me:settings.language.hint")}</p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 語系選單的一列。**用原生 radio 而不是 Radix Select**：選項只有三、四個，
 * 攤開來看得見全部、鍵盤方向鍵直接換，也不必處理彈出層的關閉與焦點。
 */
function LocaleOption({
  checked,
  label,
  onSelect,
}: {
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name="locale"
        className="h-4 w-4"
        checked={checked}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
