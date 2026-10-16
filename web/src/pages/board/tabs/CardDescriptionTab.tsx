import { useState } from "react";
import type { CardResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

interface Props {
  card: CardResponse;
  canEdit: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
}

export function CardDescriptionTab({ card, canEdit, onSave }: Props) {
  const { t } = useTranslation(["common", "card"]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.description ?? "");
  const [saving, setSaving] = useState(false);

  // 儲存等 mutation 完成才關閉編輯（spec #9）：失敗保留文字留在編輯態
  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ description: text });
      setEditing(false);
    } catch {
      // 失敗保留編輯態與文字；toast 由 saveCard 的 onError 顯示
    } finally {
      setSaving(false);
    }
  };

  if (!editing)
    return (
      <div className="text-sm">
        {card.description ? (
          <p
            className={canEdit ? "cursor-pointer whitespace-pre-wrap hover:text-foreground" : "whitespace-pre-wrap"}
            onClick={() => canEdit && setEditing(true)}
          >
            {card.description}
          </p>
        ) : (
          <p
            className={canEdit ? "cursor-pointer text-muted-foreground hover:text-foreground" : "text-muted-foreground"}
            onClick={() => canEdit && setEditing(true)}
          >
            {canEdit ? t("card:description.empty.canEdit") : t("card:description.empty.readonly")}
          </p>
        )}
      </div>
    );

  return (
    <div className="space-y-2">
      <textarea
        className="h-32 w-full rounded border p-2 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={handleSave}>{t("common:action.save")}</Button>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => { setText(card.description ?? ""); setEditing(false); }}>{t("common:action.cancel")}</Button>
      </div>
    </div>
  );
}
