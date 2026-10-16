import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Compass, ArrowLeft, Home } from "lucide-react";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation(["common"]);
  const navigate = useNavigate();

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center p-6 text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
        <Compass className="h-10 w-10 animate-pulse" />
      </div>
      <span className="text-xs font-semibold tracking-wider text-primary uppercase">404 Error</span>
      <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl text-foreground">
        {t("common:notFound.title")}
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground leading-relaxed">
        {t("common:notFound.description")}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          {t("common:notFound.back.action")}
        </Button>
        <Button size="sm" asChild className="gap-1.5">
          <Link to="/projects">
            <Home className="h-4 w-4" />
            {t("common:notFound.projects.action")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
