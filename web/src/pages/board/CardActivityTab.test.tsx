// 「活動」分頁（`CardActivityTab`）的測試。
//
// 2026-09-21 自單一檔的 CardDialog.test.tsx 按分頁拆出（見
// `.superpowers/sdd/2026-09-21-entask-carddialog-test-split/progress.md`）。
// 這一檔的兩支 describe 都以 en 執行：缺陷只存在於目標語系（zh-TW 沒有大小寫與時態），
// 中文斷言、`tsc -b`、parity 與 `i18next-parser` 都不會響。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { setLocale } from "@/i18n";
import { resources } from "@/i18n/resources";
import { cardFixture, renderDialog } from "./card-dialog-test-utils";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// ItemDetailsTab 以 zustand selector 形式呼叫 useAuth((s) => s.user?.userId)——
// mock 須支援 selector 引數，selector 形式回傳 "u1"（真實 AuthUser 欄位為 userId）
vi.mock("@/stores/auth", () => ({
  useAuth: (sel?: (s: unknown) => unknown) =>
    sel
      ? sel({ user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } })
      : { user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } },
}));

beforeEach(() => vi.clearAllMocks());

// 活動牆的標籤不是一句獨立的話，而是**接在人名之後的謂語**（`CardActivityTab` 把它渲染成
// 緊鄰人名的一個 span，中間沒有標點）。所以它必須是小寫開頭——`Alice archived the card`。
//
// 這條缺陷 zh-TW 完全看不到（中文沒有大小寫與時態），28 條中文斷言、`tsc -b`、
// parity、`i18next-parser` 全都不會響。**這一支釘的是渲染路徑，不是 28 條的值**——
// fixture 只有一筆 `activityType.create`，所以它只走得到那一條；28 條的值由
// `i18n.test.ts` 的同名 describe 逐條守（不寫在那裡的話，其餘 27 條是全庫零守門員）。
// 與 B2-4 收尾的無障礙名稱、B2-6b 的 tooltip 是同一類（缺陷只存在於目標語系）。
describe("活動牆的標籤是小寫謂語，接在人名之後讀成一句英文", () => {
  afterEach(async () => {
    await act(async () => {
      await setLocale(null);
    });
  });

  it("en 之下的活動串是 `admin created the card`，不是 `Created the card`", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url.startsWith("/cards/c1/activity")) return Promise.resolve({ data: { items: [{ id: "a1", cardId: "c1", userId: "u1", username: "admin", displayName: "admin", type: "create", text: null, detail: null, createdAt: "2026-08-15T00:00:00Z" }], nextCursor: null } });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url.includes("/activity")) return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });

    await act(async () => {
      await setLocale("en");
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    // 缺陷回歸點：只把 `card:activityType.create` 改回大寫開頭，上一行變紅（下面那行
    // 只在「同一畫面上兩種拼法並存」時才有意義，不會與上一行同時失敗——上一行紅就中止了）。
    expect(await screen.findByText("created the card")).toBeInTheDocument();
    expect(screen.queryByText("Created the card")).toBeNull();
  });
});

// ===== Task 7：活動牆的審查細節 =====
//
// `review_submitted` 的活動自 Task 2 起帶著一份 JSON detail（`{ reviewId, status, score, comment }`），
// 活動牆把它接在型別標籤後面。**這條路不經過任何標籤表**：沒渲染它時，`check:labels`、
// `i18next-parser`、parity、`tsc -b` 與 `i18n.test.ts` 的 28 條值全都不會紅——
// 畫面只是少了一截，而 zh-TW 與 en 都一樣（與 B2-4 的 `mindmap_bound` 同一類盲區）。
//
// 渲染路徑沿用上面那支 en 活動牆測試的同一條（`renderDialog` ＋ 切到活動分頁 ＋
// 既有的 URL switch mock），不為它另建第二套 fixture。
describe("活動牆的審查細節", () => {
  afterEach(async () => {
    await act(async () => {
      await setLocale(null);
    });
  });

  // 分頁名稱跟著語系走（zh-TW 活動 / en Activity）——寫死其中一個的話，另一邊會在
  // 「找不到分頁」的地方紅，紅得與被測行為無關。
  async function renderActivityReview(detail: string | null, tabName = "活動") {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url.startsWith("/cards/c1/activity")) return Promise.resolve({ data: { items: [{ id: "a1", cardId: "c1", userId: "u1", username: "admin", displayName: "admin", type: "review_submitted", text: null, detail, createdAt: "2026-08-15T00:00:00Z" }], nextCursor: null } });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url.includes("/activity")) return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: tabName }));
    fireEvent.click(screen.getByRole("tab", { name: tabName }));
  }

  it("退回的活動把立場與原因接在型別標籤後面", async () => {
    await renderActivityReview(JSON.stringify({ reviewId: "r1", status: "rejected", score: null, comment: "測試失敗，請修正" }));

    // 整串＝型別標籤 ＋ 立場 ＋ 意見，是單一文字節點。score 為 null 時那一格不接上去
    // ——`parts.join("")` 的結果就是這一串，少接一段或多接一段都會紅。
    // （分隔符是空字串：`card:review.score` 自帶前導空白、`card:review.comment` 自帶括號。）
    expect(await screen.findByText("提交審查已退回——（測試失敗，請修正）")).toBeInTheDocument();
  });

  it("通過的活動帶分數", async () => {
    await renderActivityReview(JSON.stringify({ reviewId: "r1", status: "approved", score: 4, comment: null }));
    // 與上一支成對：少了 approved 這一格時，通過的審查在活動牆上只剩一個分數，沒有立場
    expect(await screen.findByText("提交審查已通過 4 分")).toBeInTheDocument();
  });

  it.each([
    ["null", null],
    ["壞掉的 JSON", "{ 這不是 JSON"],
  ] as [string, string | null][])("detail 是 %s 時只顯示型別標籤，不讓整頁爆掉", async (_label, detail) => {
    await renderActivityReview(detail);
    // 兩個案例都是**防禦性**的：現行寫入端（`ReviewEndpoints` 的 `activity.AddAsync(...
    // detail: new { reviewId, ... })`）一定寫合法 JSON，但 `ActivityResponse.detail`
    // 的型別本來就是 `string | null`，而 `JSON.parse` 是在 render 裡呼叫的
    // ——拋出去會讓整個活動分頁掛掉。測的是降級路徑，不是現行資料。
    expect(await screen.findByText("提交審查")).toBeInTheDocument();
  });

  it("en 之下立場走標籤，不是原始識別碼", async () => {
    await act(async () => {
      await setLocale("en");
    });
    await renderActivityReview(JSON.stringify({ reviewId: "r1", status: "rejected", score: null, comment: "failed" }), "Activity");

    // 前置：活動列已經渲染。**這一行的存在與位置都是必要的**——`queryByText` 是同步的，
    // 少了它，下面那行會在查詢還沒回來時就跑，於是**永遠是綠的**（負向實測 a2 抓到：
    // 把立場換成 `d.status` 時，紅的是最下面那行而不是這一組）。用型別標籤當錨點，
    // 因為它與 detail 無關，兩個突變下都在。
    expect(await screen.findByText(/submitted a review/)).toBeInTheDocument();

    // **三行的順序是刻意的：每一行各有各的突變能讓它單獨變紅。**
    //   1. 把 `d.status` 直接接上去 → 這一行紅（原始識別碼出現在畫面上；上一行的錨點
    //      因為是子字串比對，仍然是綠的）
    //   2. 讓 detail 那一段回空字串 → 下一行紅（立場整段不見了）
    // 反過來寫的話，突變 1 會先讓下一行紅，這一行永遠不會是失敗的那一行
    // （Task 6 scoped re-review 的 M-a 就是這個形狀）。
    //
    // **這一行的探針在 2026-09-19 換過形狀**（產品文案第 5 條把 en 的立場標籤改成
    // 小寫的 `: rejected —`）：舊的 `/rejected/` 是靠「**標籤首字大寫、識別碼全小寫**」
    // 這個大小寫差在分辨的，而那個差正是第 5 條要消滅的東西——留著它會變成一支
    // 命中**正確**渲染的假紅燈，或者更糟：被順手改成 `/rejected/i` 而**永遠是綠的**。
    // 它守的突變沒有變，換的是**只有識別碼被接上去才會出現的形狀**：`parts.push(d.status)`
    // 少了標籤自帶的 `: `，立場會直接黏上型別標籤（`reviewrejected`；就算補一個空白
    // 也仍然不是標籤的形狀）。
    expect(screen.queryByText(/review\s?rejected/)).toBeNull();
    // `join("")` 沒有分隔符可言，所以每一段要自己解決「接在前一段後面」：
    // `card:review.detail.rejected` 用**冒號**起頭（`: rejected —`——2026-09-19 的
    // 產品文案第 5 條，原本是自帶前導空白的 ` Rejected —`），
    // 而 `card:review.comment` 是 ` ({{comment}})`、`card:review.score` 是
    // ` {{score}} pts`（後兩條仍靠前導空白）。
    // **這一行原本釘的是缺陷**（`submitted a reviewRejected — (failed)`——立場黏在
    // 型別標籤上）；Task 7 fix round 1 修了三個值之後，它釘的是修好的形狀。
    expect(await screen.findByText("submitted a review: rejected — (failed)")).toBeInTheDocument();
  });

  // **可達組合矩陣。** 後端契約（Task 2 的 `ReviewStatuses.Submittable` 與回填
  // migration 的 `WHERE "Status" <> 'pending'`）保證可達的只有這五種：approved
  // 各自搭配有無分數／意見，而 rejected **一定有意見、一定沒有分數**。
  //
  // **斷言用 `element.textContent` 而不是 `getByText`——這不是風格偏好。**
  // Testing Library 的預設 normalizer 會把連續空白收斂成一個，所以 `getByText`
  // 抓得到「少了一個空白」、**永遠抓不到「多了一個空白」**（`a  b` 與 `a b` 對它同值）。
  // 這一組修的正是空白，而最可能的修錯法就是把某一段的空白兩邊都留著。
  const detailJson = (status: string, score: number | null, comment: string | null) =>
    JSON.stringify({ reviewId: "r1", status, score, comment });

  it.each([
    ["通過（無分數無意見）", "approved", null, null, "submitted a review: approved"],
    ["通過＋分數", "approved", 4, null, "submitted a review: approved 4 pts"],
    ["通過＋意見", "approved", null, "ok", "submitted a review: approved (ok)"],
    ["通過＋分數＋意見", "approved", 4, "ok", "submitted a review: approved 4 pts (ok)"],
    ["退回＋意見（退回不帶分數）", "rejected", null, "failed", "submitted a review: rejected — (failed)"],
  ] as [string, string, number | null, string | null, string][])(
    "en 的 %s 讀成一句英文（整串逐字元比對，含空白）",
    async (_label, status, score, comment, expected) => {
      await act(async () => {
        await setLocale("en");
      });
      await renderActivityReview(detailJson(status, score, comment), "Activity");

      const line = await screen.findByText(/^submitted a review/);
      // `textContent` 是原始值——型別標籤與 detail 是同一個 `<span>` 的兩個相鄰文字節點，
      // `join("")` 的結果就是這一串。少了空白、多了空白、順序錯，都在這裡現形。
      expect(line.textContent).toBe(expected);
    },
  );

  // 上面那支看的是**渲染結果**；這支直接看 en 的原始值。**兩者是不同的眼睛**：
  // 渲染會經過 `join("")`，而原始值的**尾端**空白在渲染上完全看不出來
  // （後面接了別的字，或那一格根本沒渲染）——`detail.rejected` 的尾端空白就是這樣
  // 躲過去的（當時是 ` Rejected — ` ＋ ` (failed)` 會是雙空白，Task 7 那一批把它拿掉）。
  //
  // **2026-09-19 起 `detail.*` 改成自己帶冒號**（`: approved`／`: rejected —`，
  // 產品文案第 5 條：句首大寫的立場詞不該出現在句中），「每一段都靠前導空白接續」
  // 因此只剩 comment 與 score 兩條。**這一支守的東西不變**：四條的尾端都不可以有空白。
  it("en 的 review 各段自帶接續方式，且四條都沒有尾端空白", async () => {
    const card = resources.en.card as unknown as {
      review: { detail: { approved: string; rejected: string }; comment: string; score: string };
    };
    // detail 兩條用冒號起頭（`: ` 自己就是分隔符，不需要前導空白）；
    // comment 與 score 接在別的字後面（立場／分數的 `pts`），前導空白是這一段的一部分。
    expect(card.review.detail.approved).toBe(": approved");
    expect(card.review.detail.rejected).toBe(": rejected —");
    expect(card.review.comment).toBe(" ({{comment}})");
    expect(card.review.score).toBe(" {{score}} pts");
  });
});

// 分頁（`state/45`）：第二頁必須帶 `cursor=`（舊的 `before=` 已無消費者）。
// 兩頁的列刻意用**同一條渲染路徑**的兩個不同 detail：第一頁有分數、第二頁沒有
// ⇒ 「第二頁的列真的接上來了」與「第二頁根本沒打」在畫面上分得開。
describe("活動牆分頁", () => {
  it("載入更多以 cursor 打第二趟，列接在後面", async () => {
    const { api } = await import("@/lib/api");
    const cursor = "2026-01-01T00:00:00.0000000Z|3f2a1b4c-0000-0000-0000-000000000000";
    const row = (id: string, detail: string | null, createdAt: string) => ({
      id, cardId: "c1", userId: "u1", username: "admin", displayName: "admin",
      type: "review_submitted", text: null, detail, createdAt,
    });
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/cards/c1/activity?filter=activity_only")
        return Promise.resolve({
          data: {
            items: [row("a1", JSON.stringify({ reviewId: "r1", status: "approved", score: 4, comment: null }), "2026-08-15T00:00:00Z")],
            nextCursor: cursor,
          },
        });
      if (url === `/cards/c1/activity?filter=activity_only&cursor=${encodeURIComponent(cursor)}`)
        return Promise.resolve({ data: { items: [row("a2", null, "2026-08-14T00:00:00Z")], nextCursor: null } });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      // 未知的**活動** URL 回空頁——`getNextPageParam` 若回錯的東西（例如常數），
      // 第二頁會落到這裡、畫面少一列，這一支就會紅在 findByText 上（不是崩在 undefined）。
      // 非活動 URL 仍回空陣列：`/projects/p1/members` 的 `.map` 就在 CardDialog 的預設
      // 分頁上，回一個物件會讓整個 dialog 在 render 時炸掉（紅在 findByDisplayValue，
      // 紅得與這支要測的分頁無關）。
      if (url.includes("/activity")) return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "活動" }));
    fireEvent.click(screen.getByRole("tab", { name: "活動" }));

    expect(await screen.findByText("提交審查已通過 4 分")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "載入更多" }));

    expect(await screen.findByText("提交審查")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(
      `/cards/c1/activity?filter=activity_only&cursor=${encodeURIComponent(cursor)}`,
    );
    // 第二頁的 nextCursor 是 null ⇒ 按鈕消失（hasNextPage 的語意）
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "載入更多" })).toBeNull(),
    );
  });
});
