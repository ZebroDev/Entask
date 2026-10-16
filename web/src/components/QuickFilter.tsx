import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { User, Calendar, AlertTriangle, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

export type FilterType = "all" | "my" | "dueToday" | "overdue";

interface QuickFilterProps {
  value: FilterType;
  onChange: (filter: FilterType) => void;
  counts?: {
    all?: number;
    my?: number;
    dueToday?: number;
    overdue?: number;
  };
  className?: string;
}

export function QuickFilter({ value, onChange, counts, className = "" }: QuickFilterProps) {
  // Shortcut: press 'f' to toggle between 'all' and 'my'
  const { t } = useTranslation(["common"]);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "f" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        onChange(value === "my" ? "all" : "my");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [value, onChange]);

  const items: { type: FilterType; label: string; icon: React.ReactNode; count?: number; shortcut?: string }[] = [
    { type: "all", label: t("common:filter.all"), icon: <Layers className="h-3.5 w-3.5" />, count: counts?.all },
    { type: "my", label: t("common:filter.assignedToMe"), icon: <User className="h-3.5 w-3.5" />, count: counts?.my, shortcut: "F" },
    { type: "dueToday", label: t("common:filter.dueToday"), icon: <Calendar className="h-3.5 w-3.5" />, count: counts?.dueToday },
    { type: "overdue", label: t("common:state.overdue"), icon: <AlertTriangle className="h-3.5 w-3.5 text-destructive" />, count: counts?.overdue },
  ];

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {items.map((item) => {
        const isActive = value === item.type;
        return (
          <Button
            key={item.type}
            size="sm"
            variant={isActive ? "secondary" : "ghost"}
            className={`h-7 px-2.5 text-xs gap-1.5 transition-all rounded-full ${
              isActive
                ? "bg-secondary text-secondary-foreground font-semibold shadow-xs ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => onChange(item.type)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.count !== undefined && item.count > 0 && (
              <span
                className={`ml-0.5 rounded-full px-1.5 py-0.2 text-[10px] ${
                  isActive
                    ? "bg-primary text-primary-foreground font-bold"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {item.count}
              </span>
            )}
            {item.shortcut && (
              <kbd className="hidden sm:inline-block text-[9px] font-mono opacity-60 bg-muted px-1 rounded border">
                {item.shortcut}
              </kbd>
            )}
          </Button>
        );
      })}
    </div>
  );
}
