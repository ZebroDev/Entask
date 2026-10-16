// CardDialog 系列的共用測試工具（2026-09-21 自 CardDialog.test.tsx 抽出的第一刀）。
//
// **`vi.mock` 刻意不放進來。** 它是**檔案作用域**且被提升到模組頂端——由別的模組轉出
// 不會生效，而 mock 沒生效的失敗方式可能是靜默的。所以每個用到它們的測試檔都**逐字**
// 複製那三段 `vi.mock`（見各檔開頭的註解與 `card-dialog-test-utils` 的說明）；
// 這裡只放不依賴 mock 的東西：共用 fixture 與 render 路徑。
//
// `cardFixture` 是**唯讀的共用基底**：各檔以展開（`{ ...cardFixture, … }`）衍生自己的
// fixture，全檔沒有任何一處就地改寫它（拆分前後皆如此）。
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CardDialog } from "./CardDialog";

export const cardFixture = {
  id: "c1", listId: "l1", title: "測試卡", description: "描述", position: "h",
  isArchived: false, dueAt: null, estimatedHours: 8, coverAttachmentId: null,
  createdById: "u1", createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z",
  members: [], labels: [], checklists: [],
  attachments: [], customFields: [], reviews: [], reviewState: null,
  effort: { logs: [], totalHours: 0 }, mindMapNodes: [],
};

export function renderDialog(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/p1/boards/b1/cards/c1"]}>
        <Routes>
          <Route path="/projects/:projectId/boards/:boardId/cards/:cardId" element={<CardDialog />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export async function getApi() {
  return await import("@/lib/api");
}
