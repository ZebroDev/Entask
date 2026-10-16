import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Layers, Loader2, Sparkles, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SOURCE_URL } from "@/lib/source-offer";

export function LoginPage() {
  const { t } = useTranslation(["common", "auth"]);
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(username, password);
      const fromLoc = (location.state as any)?.from;
      const target = fromLoc ? `${fromLoc.pathname || ""}${fromLoc.search || ""}` : "/projects";
      navigate(target || "/projects", { replace: true });
    } catch {
      toast.error(t("auth:error.login"));
    } finally {
      setLoading(false);
    }
  };

  const fillDemoAdmin = () => {
    setUsername("admin");
    setPassword("Entask@Dev2026");
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 bg-background overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))] dark:bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.25),rgba(0,0,0,0))] pointer-events-none" />

      <div className="relative w-full max-w-[400px] space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25 mb-1">
            <Layers className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center justify-center gap-1.5">
            Entask
            <Sparkles className="h-4 w-4 text-primary" />
          </h1>
          <p className="text-xs text-muted-foreground">
            {t("auth:login.hint")}
          </p>
        </div>

        {/* Login Card */}
        <Card className="border-border/60 shadow-xl backdrop-blur-sm bg-card/95">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">{t("auth:login.title")}</CardTitle>
            <CardDescription className="text-xs">{t("auth:login.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-xs">{t("auth:login.username.label")}</Label>
                <Input
                  id="username"
                  placeholder={t("auth:login.username.placeholder")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="h-9 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-xs">{t("auth:login.password.label")}</Label>
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-9 text-sm"
                />
              </div>

              <Button type="submit" className="w-full h-9 text-sm gap-2 font-medium" disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? t("common:state.signingIn") : t("auth:login.action")}
              </Button>
            </form>

            {/* Quick Demo Credentials Fill — 僅開發環境。
                `import.meta.env.DEV` 在 `vite build` 被替換成 false，整塊連同
                fillDemoAdmin 的帳密字面值一起被折疊掉；production bundle 不含它。
                提示與按鈕必須同進同出——只留提示會是半句話。 */}
            {import.meta.env.DEV && (
              <div className="pt-3 border-t text-center">
                <p className="text-[11px] text-muted-foreground mb-2">{t("auth:demo.hint")}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={fillDemoAdmin}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {t("auth:demo.fill.action")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Footer info */}
        <p className="text-center text-[11px] text-muted-foreground">
          {t("auth:login.footer")}
        </p>

        {/* AGPL-3.0 §13 的 Source offer。擺在這一頁是因為登入頁是每個遠端使用者的必經
            之路；獨立一行而不是接在前一行尾端，理由同樣是 §13 的 prominently。
            已登入且 session 常駐、回不到這頁的人由 AppLayout 的使用者選單補上。 */}
        <p className="text-center text-[11px]">
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            title={t("common:sourceOffer.title")}
            className="text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
          >
            {t("common:sourceOffer.link")}
          </a>
        </p>
      </div>
    </div>
  );
}
