import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Keyboard, Search, Plus, Filter, CornerDownLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ShortcutsHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function ShortcutsHelpDialog({ open, onOpenChange }: ShortcutsHelpDialogProps) {
  const { t } = useTranslation(["common"]);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.key === "?" || (e.shiftKey && e.key === "/")) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
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
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  const sections = [
    {
      title: t("common:shortcuts.section.navigation"),
      items: [
        {
          label: t("common:shortcuts.search.label"),
          keys: [isMac ? "⌘" : "Ctrl", "K"],
          icon: <Search className="h-4 w-4 text-primary" />,
        },
        {
          label: t("common:shortcuts.help.label"),
          keys: ["?"],
          icon: <Keyboard className="h-4 w-4 text-primary" />,
        },
        {
          label: t("common:shortcuts.escape.label"),
          keys: ["Esc"],
          icon: <X className="h-4 w-4 text-muted-foreground" />,
        },
      ],
    },
    {
      title: t("common:shortcuts.section.board"),
      items: [
        {
          label: t("common:shortcuts.createCard.label"),
          keys: ["C"],
          icon: <Plus className="h-4 w-4 text-emerald-500" />,
        },
        {
          label: t("common:shortcuts.quickFilter.label"),
          keys: ["F"],
          icon: <Filter className="h-4 w-4 text-blue-500" />,
        },
        {
          label: t("common:shortcuts.submit.label"),
          keys: ["Enter"],
          icon: <CornerDownLeft className="h-4 w-4 text-muted-foreground" />,
        },
        {
          label: t("common:shortcuts.createAnother.label"),
          keys: [isMac ? "⌘" : "Ctrl", "Enter"],
          icon: <CornerDownLeft className="h-4 w-4 text-emerald-500" />,
        },
      ],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Keyboard className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">{t("common:shortcuts.title")}</DialogTitle>
              <DialogDescription className="text-xs">
                {t("common:shortcuts.description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {sections.map((sec) => (
            <div key={sec.title} className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
                {sec.title}
              </h4>
              <div className="divide-y rounded-lg border bg-muted/30">
                {sec.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between p-2.5 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 text-sm">
                      {item.icon}
                      <span>{item.label}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {item.keys.map((k, i) => (
                        <kbd
                          key={i}
                          className="inline-flex h-5 items-center justify-center rounded border bg-background px-1.5 font-mono text-[11px] font-semibold text-foreground shadow-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="text-[11px] text-center text-muted-foreground pt-1">
          {t("common:shortcuts.hint")}
        </div>
      </DialogContent>
    </Dialog>
  );
}
