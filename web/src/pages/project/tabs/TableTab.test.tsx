import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { TableTab, type ProjectCardItem } from './TableTab'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import type { Mock } from 'vitest'
import i18n, { setLocale } from '../../../i18n'

const makeWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

// 標型別（`ProjectCardItem`）而不是只把欄位補上去：`reviewState` 是非 optional，
// 標了之後漏欄位會當場編譯紅，而不是靜默通過（`(api.get as Mock).mockResolvedValue`
// 讓 mock 走 `any`，那條路本來沒有任何型別檢查）。
const mockCards: { items: ProjectCardItem[]; total: number; page: number; pageSize: number } = {
  items: [
    {
      id: 'c1', title: '卡片 A',
      boardId: 'b1', boardName: '前端看板', listId: 'l1', listName: '進行中',
      dueAt: new Date(Date.now() - 86400000).toISOString(),
      completedAt: null,
      isOverdue: true, isArchived: false,
      assignees: [{ userId: 'u1', username: 'alice', displayName: 'Alice' }],
      labelNames: [], estimatedHours: 4, loggedHours: 2,
      checklistProgress: { total: 5, completed: 2 },
      reviewState: null,
    },
    {
      id: 'c2', title: '卡片 B',
      boardId: 'b2', boardName: '後端看板', listId: 'l2', listName: '待辦',
      dueAt: new Date(Date.now() + 86400000 * 7).toISOString(),
      completedAt: '2026-09-01T00:00:00Z',
      isOverdue: false, isArchived: false,
      assignees: [], labelNames: [], estimatedHours: null, loggedHours: 0,
      checklistProgress: { total: 0, completed: 0 },
      reviewState: null,
    },
  ],
  total: 2, page: 1, pageSize: 200,
}

describe('TableTab', () => {
  beforeEach(() => {
    (api.get as Mock).mockResolvedValue({ data: mockCards });
    (api.put as Mock).mockResolvedValue({ data: {} });
  })

  it('renders_all_columns', async () => {
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByText('卡片標題')).toBeInTheDocument()
      expect(screen.getByText('看板')).toBeInTheDocument()
      expect(screen.getByText(/截止日/)).toBeInTheDocument()
    })
  })

  it('sorts_by_dueAt_ascending', async () => {
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText(/截止日/))
    // Default is already dueAt asc, so let's reverse it to see change
    fireEvent.click(screen.getByText(/截止日/))
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('卡片 B')
  })

  it('filters_by_boardId', async () => {
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'b2' } })
    await waitFor(() => {
      expect(screen.queryByText('卡片 A')).not.toBeInTheDocument()
      expect(screen.getByText('卡片 B')).toBeInTheDocument()
    })
  })

  it('shows_overdue_date_in_red', async () => {
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))
    const overdueCell = document.querySelector('[data-overdue="true"]')
    expect(overdueCell).toBeInTheDocument()
  })

  it('separates_row_selection_from_completion', async () => {
    render(<TableTab projectId="p1" canEdit={true} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    const headerCheckbox = screen.getByLabelText('全選')
    const rowCheckboxes = screen.getAllByRole('checkbox').filter(cb => cb !== headerCheckbox && (cb as HTMLInputElement).type !== 'checkbox')
    expect(rowCheckboxes.length).toBe(2)

    // Clicking row checkbox selects the row and does not mutate completion
    fireEvent.click(rowCheckboxes[0])
    expect(api.put).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText('已選取 1 項')).toBeInTheDocument()
    })
  })

  it('toggles_select_all_from_header', async () => {
    render(<TableTab projectId="p1" canEdit={true} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    const headerCheckbox = screen.getByLabelText('全選')

    // Click header select all -> all 2 selected
    fireEvent.click(headerCheckbox)
    await waitFor(() => {
      expect(screen.getByText('已選取 2 項')).toBeInTheDocument()
    })

    // Click header select all again -> 0 selected
    fireEvent.click(headerCheckbox)
    await waitFor(() => {
      expect(screen.queryByText(/已選取/)).not.toBeInTheDocument()
    })
  })

  it('respects_canEdit_for_completion_button_and_bulk_bar', async () => {
    // When canEdit is false
    const { unmount } = render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    expect(screen.queryByTitle('標記為完成')).not.toBeInTheDocument()
    expect(screen.queryByTitle('標記為未完成')).not.toBeInTheDocument()

    // Select row when canEdit is false: bulk bar should not appear
    const headerCheckbox = screen.getByLabelText('全選')
    const rowCheckboxes = screen.getAllByRole('checkbox').filter(cb => cb !== headerCheckbox && (cb as HTMLInputElement).type !== 'checkbox')
    fireEvent.click(rowCheckboxes[0])
    expect(screen.queryByText(/已選取/)).not.toBeInTheDocument()

    unmount()

    // When canEdit is true
    render(<TableTab projectId="p1" canEdit={true} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    const markCompleteBtn = screen.getByTitle('標記為完成')
    expect(markCompleteBtn).toBeInTheDocument()
    const markIncompleteBtn = screen.getByTitle('標記為未完成')
    expect(markIncompleteBtn).toBeInTheDocument()

    // Click mark complete for card A
    fireEvent.click(markCompleteBtn)
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/cards/c1/completion', { isCompleted: true })
    })
  })

  it('triggers_batch_actions_from_floating_bar', async () => {
    render(<TableTab projectId="p1" canEdit={true} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    const headerCheckbox = screen.getByLabelText('全選')
    fireEvent.click(headerCheckbox)

    await waitFor(() => {
      expect(screen.getByText('已選取 2 項')).toBeInTheDocument()
    })

    // Click 封存 (Bulk archive)
    const archiveBtn = screen.getByRole('button', { name: /封存/ })
    fireEvent.click(archiveBtn)

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/cards/c1', { isArchived: true })
      expect(api.put).toHaveBeenCalledWith('/cards/c2', { isArchived: true })
    })
  })
})

// 這一條不是在驗「翻譯對不對」，是在驗**無障礙名稱的來源**：完成鈕裡面只有一個勾圖示、
// 沒有可見文字，名稱完全來自 title。2026-09-14 之前它是寫死的英文（"Mark complete"／
// "Mark incomplete"），而四道防線全都看不到——tsc、zh-TW 斷言、parity、i18next-parser
// 對「非 CJK 的硬編碼可見文字」同時隱形（設計 §4.3 的盲區類別）。
// 上面四條 zh-TW 斷言只證明「改走 t() 之後 zh-TW 對了」，擋不住「改回寫死中文」——
// 寫死的中文在 zh-TW 畫面下看起來仍然是對的。真正的不變量是下面這一條，所以它必須以 en 執行。
describe('卡片完成鈕的無障礙名稱跟著語系走', () => {
  it('切到 en 後是 Mark as complete／Mark as incomplete', async () => {
    // 不需要 afterEach 還原：src/test/setup.ts 的 beforeEach 會清掉語系鍵
    // （它刻意放在 beforeEach——afterEach 會在 RTL 卸載元件前跑而產生 act 警告）。
    await act(async () => { await setLocale("en") })
    render(<TableTab projectId="p1" canEdit={true} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    // 兩張卡一完成一未完成，兩個狀態同時在畫面上。
    expect(screen.getByTitle('Mark as complete')).toBeInTheDocument()
    expect(screen.getByTitle('Mark as incomplete')).toBeInTheDocument()
  })
})

describe('TableTab 的審查狀態徽章', () => {
  const withReviewState = (reviewState: 'pending' | 'approved' | 'rejected' | null) => ({
    data: { ...mockCards, items: [{ ...mockCards.items[0], reviewState }] },
  })

  it.each<['pending' | 'approved' | 'rejected', string]>([
    ['pending', '待審查'],
    ['approved', '通過'],
    ['rejected', '退回'],
  ])('reviewState=%s 時顯示 %s', async (reviewState, label) => {
    (api.get as Mock).mockResolvedValue(withReviewState(reviewState));
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('reviewState 為 null 時不顯示任何審查狀態徽章', async () => {
    (api.get as Mock).mockResolvedValue(withReviewState(null));
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    await screen.findByText('卡片 A');
    expect(screen.queryByText('待審查')).not.toBeInTheDocument();
    expect(screen.queryByText('通過')).not.toBeInTheDocument();
    expect(screen.queryByText('退回')).not.toBeInTheDocument();
  });

  // 跨視圖一致性（本階段四個落點的最終契約）。四個視圖共用 `lib/review-badge.ts`，
  // 但**共用不是斷言**——任何一個落點自己接死字串、或接到別的 key，四道閘門都不會響
  // （它們比的是後端常數、前端 switch 與語系檔，不看呼叫端接對沒有）。
  // 表格這一支走**可見文字**（表格沒有 aria-label），所以它同時釘住來源與畫面：
  // 第一條是來源（釘住共用的鍵），第二條是畫面逐字等於它。
  // 判別力在第二條：實測（2026-09-17）只留第二條並把 zh-TW 的 rejected 譯文改壞，
  // 這支當場紅（`findByText` 是精確比對）——來源那一條的價值是失敗時指出契約的來源。
  it('rejected 的徽章逐字等於共用翻譯的退回', async () => {
    (api.get as Mock).mockResolvedValue(withReviewState('rejected'));
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    expect(i18n.t('common:state.rejected')).toBe('退回');
    expect(await screen.findByText('退回')).toBeInTheDocument();
  });
});

// 靜默截斷的回歸測試。伺服器端的 pageSize 上限是 500（`ProjectCardEndpoints` 硬擋 >500），
// 而這個檢視沒有分頁 UI ⇒ 超過 500 張的專案只拿得到前 500 張。修掉之前，`rowCount` 印的是
// 「已載入的」而畫面讀起來像「全部的」——表格不完整，卻沒有任何異狀。
//
// **兩支成對，判別力在第二支**：只寫「截斷時要顯示」的話，「無條件顯示」也照樣綠。
// 這個 describe 是 `TableTab` 那個的**兄弟**，繼承不到它的 `beforeEach`
// ⇒ 每一支都自己設定 mock。（實測踩到：只設第一支時，第二支讀到第一支留下的 600。）
describe('TableTab 的截斷提示', () => {
  it('total 大於已載入筆數時，提示與已載入筆數同時顯示', async () => {
    (api.get as Mock).mockResolvedValue({ data: { ...mockCards, total: 600 } })
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    expect(screen.getByText('共 600 筆，僅載入前 2 筆')).toBeInTheDocument()
    // 提示是**附加**的，不是取代原本的筆數——兩者要能同時讀到。
    // 這一句同時釘住「提示講的是**資料集**（已載入 vs 全部），不是**表格列數**」：
    // 左邊 `rowCount` 是 `sorted.length`（受看板篩選影響），右邊的 500 是伺服器截斷邊界。
    expect(screen.getByText('2 筆')).toBeInTheDocument()
  })

  it('total 等於已載入筆數時不顯示提示', async () => {
    (api.get as Mock).mockResolvedValue({ data: mockCards })
    render(<TableTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))

    expect(screen.queryByText(/僅載入前/)).not.toBeInTheDocument()
  })
})

// ★ 判準是「實際的 tabIndex 值」，不是「有沒有 tabindex 屬性」——列內那兩顆在修改前
//   **根本沒有 tabindex 屬性**（原生 `<button>` 本來就在 tab 順序裡），只數屬性會把
//   6 個停留點數成 2 個。這個 helper 的存在理由就是那個量測校正。
const tabbableIn = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
    .filter((el) => el.getAttribute('tabindex') !== '-1' && !el.hasAttribute('disabled'))

// 兄弟 describe，繼承不到上面那個的 `beforeEach` ⇒ 每一支自己設定 mock（同截斷提示那個）。
describe('TableTab 的 composite grid（2026-09-27）', () => {
  const rowsOf = () => Array.from(document.querySelectorAll<HTMLElement>('tbody > tr[data-grid-row]'))

  async function renderGrid(canEdit = true) {
    // ★ 分號是必要的，不是風格：下一行以 `(` 開頭 ⇒ 少了它 ASI 不會補，
    //   整個會變成 `…mockResolvedValue({...})(api.put as Mock)…`（把回傳值當函式呼叫），
    //   而錯誤訊息指的是**上一行**那條鏈，指不到真正缺分號的這一行。
    (api.get as Mock).mockResolvedValue({ data: mockCards });
    (api.put as Mock).mockResolvedValue({ data: {} });
    const onOpenCard = vi.fn()
    render(<TableTab projectId="p1" canEdit={canEdit} onOpenCard={onOpenCard} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('卡片 A'))
    return onOpenCard
  }

  it('整個表格 body 只剩一個 Tab 停留點，且它就是當前列', async () => {
    await renderGrid(true)
    // 修改前是 6：2 列 ×（列 + checkbox + 完成鈕）
    expect(tabbableIn(document.querySelector('tbody')!).map((el) => el.tagName)).toEqual(['TR'])
  })

  it('canEdit=false 時列內少一顆，仍然只有當前列是停留點', async () => {
    await renderGrid(false)
    expect(tabbableIn(document.querySelector('tbody')!).map((el) => el.tagName)).toEqual(['TR'])
  })

  it('↑／↓／Home／End 移動焦點，tabIndex 跟著搬', async () => {
    await renderGrid()
    const [r0, r1] = rowsOf()
    r0.focus()
    expect(document.activeElement).toBe(r0)

    fireEvent.keyDown(r0, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(r1)
    expect(r1.getAttribute('tabindex')).toBe('0')
    expect(r0.getAttribute('tabindex')).toBe('-1')

    fireEvent.keyDown(r1, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(r0)

    fireEvent.keyDown(r0, { key: 'End' })
    expect(document.activeElement).toBe(r1)
    fireEvent.keyDown(r1, { key: 'Home' })
    expect(document.activeElement).toBe(r0)
  })

  it('邊界：第一列 ↑ 不動、最後一列 ↓ 不動', async () => {
    await renderGrid()
    const [r0, r1] = rowsOf()
    r0.focus()
    fireEvent.keyDown(r0, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(r0)
    r1.focus()
    fireEvent.keyDown(r1, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(r1)
  })

  it('→／← 進出列內控制項；控制項上按 ↑／↓ 會換列並落在列本身', async () => {
    await renderGrid()
    const [r0, r1] = rowsOf()
    const widgets = Array.from(r0.querySelectorAll<HTMLElement>('[data-row-widget]'))
    expect(widgets).toHaveLength(2) // checkbox ＋ 完成鈕

    r0.focus()
    fireEvent.keyDown(r0, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(widgets[0])
    fireEvent.keyDown(widgets[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(widgets[1])
    fireEvent.keyDown(widgets[1], { key: 'ArrowRight' }) // 走完繞回列
    expect(document.activeElement).toBe(r0)

    fireEvent.keyDown(r0, { key: 'ArrowLeft' }) // 在列上按 ← 不動
    expect(document.activeElement).toBe(r0)

    fireEvent.keyDown(r0, { key: 'ArrowRight' })
    fireEvent.keyDown(widgets[0], { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(r0)

    fireEvent.keyDown(widgets[0], { key: 'ArrowDown' }) // 焦點在控制項上也要能換列
    expect(document.activeElement).toBe(r1)
  })

  it('Enter 與 Space 在列上仍然開啟卡片（既有行為不變）', async () => {
    const onOpenCard = await renderGrid()
    const [r0, r1] = rowsOf()
    fireEvent.keyDown(r0, { key: 'Enter' })
    fireEvent.keyDown(r1, { key: ' ' })
    expect(onOpenCard).toHaveBeenNthCalledWith(1, 'c1')
    expect(onOpenCard).toHaveBeenNthCalledWith(2, 'c2')
  })
})

