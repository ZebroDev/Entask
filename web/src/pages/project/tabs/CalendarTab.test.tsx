import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CalendarTab, type ProjectCardItem } from './CalendarTab'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '../../../i18n'

const makeWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

vi.mock('../../../lib/api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))
// CardDialog 會用到 auth selector 與 sonner toast（popover 開卡測試）
vi.mock('../../../stores/auth', () => ({
  useAuth: (sel?: (s: unknown) => unknown) =>
    sel
      ? sel({ user: { userId: 'u1', username: 'admin', displayName: '測試員', isAdmin: false } })
      : { user: { userId: 'u1', username: 'admin', displayName: '測試員', isAdmin: false } },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const TODAY = new Date()
const YEAR = TODAY.getFullYear()
const MONTH = TODAY.getMonth() + 1
const MM = String(MONTH).padStart(2, '0')

// 標型別（`ProjectCardItem`）而不是只把欄位補上去：`reviewState` 是非 optional，
// 標了之後漏欄位會當場編譯紅，而不是靜默通過（`(api.get as Mock).mockResolvedValue`
// 讓 mock 走 `any`，那條路本來沒有任何型別檢查）。
const mockCards: { items: ProjectCardItem[]; total: number; page: number; pageSize: number } = {
  items: [
    {
      id: 'c1', title: '正常卡片',
      boardId: 'b1', boardName: '看板', listId: 'l1', listName: '待辦',
      dueAt: `${YEAR}-${MM}-15T00:00:00Z`,
      isOverdue: false, isArchived: false,
      assignees: [], labelNames: [],
      estimatedHours: null, loggedHours: 0,
      checklistProgress: { total: 0, completed: 0 },
      reviewState: null,
    },
    {
      id: 'c2', title: '逾期卡片',
      boardId: 'b1', boardName: '看板', listId: 'l1', listName: '待辦',
      dueAt: `${YEAR}-${MM}-01T00:00:00Z`,
      isOverdue: true, isArchived: false,
      assignees: [], labelNames: [],
      estimatedHours: null, loggedHours: 0,
      checklistProgress: { total: 0, completed: 0 },
      reviewState: null,
    },
    {
      id: 'c3', title: '無截止日',
      boardId: 'b1', boardName: '看板', listId: 'l1', listName: '待辦',
      dueAt: null,
      isOverdue: false, isArchived: false,
      assignees: [], labelNames: [],
      estimatedHours: null, loggedHours: 0,
      checklistProgress: { total: 0, completed: 0 },
      reviewState: null,
    },
  ],
  total: 3, page: 1, pageSize: 200,
}

import { api } from '../../../lib/api'

// 每個 URL 各回**對的形狀**。原本這幾個 describe 用「一個 `mockResolvedValue` 餵所有 URL」，
// 那在側欄改走伺服器端篩選（`hasDue=false`）之後就不再寫實：那一支也會收到帶到期日的卡片，
// 於是同一張卡同時出現在月格與側欄，`getByText` 當場變成「Found multiple elements」。
// 這不是測試變嚴格——是 fixture 先前靠前端的 `.filter(c => !c.dueAt)` 在掩護。
const mockApiRoutes = (routes: { month?: unknown; noDue?: unknown; cardDetail?: unknown }) => {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/projects/p1/permissions/mine')
      return Promise.resolve({ data: ['card.edit', 'card.read'] })
    if (url.includes('hasDue=false'))
      return Promise.resolve({ data: routes.noDue ?? { items: [], total: 0 } })
    if (url.startsWith('/cards/')) return Promise.resolve({ data: routes.cardDetail ?? {} })
    return Promise.resolve({ data: routes.month ?? mockCards })
  })
}

describe('CalendarTab', () => {
  beforeEach(() => {
    // 側欄只拿得到無到期日的那一張——與真實伺服器回得出的組合一致（total 1 ＝ 不截斷）
    mockApiRoutes({ month: mockCards, noDue: { items: mockCards.items.filter(c => !c.dueAt), total: 1 } })
  })

  it('renders_current_month_grid', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByText('日')).toBeInTheDocument()
      expect(screen.getByText('一')).toBeInTheDocument()
    })
  })

  it('shows_cards_on_due_dates', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByText('正常卡片')).toBeInTheDocument()
      expect(screen.getByText('逾期卡片')).toBeInTheDocument()
    })
  })

  it('highlights_overdue_cards_red', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      const chip = screen.getByText('逾期卡片').closest('[data-overdue]')
      expect(chip).toHaveAttribute('data-overdue', 'true')
    })
  })

  it('navigates_to_next_month', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => screen.getByText('正常卡片'))
    const nextBtn = screen.getByRole('button', { name: /下一個月/i })
    fireEvent.click(nextBtn)
    
    const nextMonth = MONTH === 12 ? 1 : MONTH + 1
    const nextYear = MONTH === 12 ? YEAR + 1 : YEAR
    await waitFor(() => {
      expect(screen.getByText(`${nextYear}年${nextMonth}月`)).toBeInTheDocument()
    })
  })

  it('shows_no_due_date_sidebar', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByText('無截止日')).toBeInTheDocument()
      expect(screen.getByText('無截止日卡片')).toBeInTheDocument()
    })
  })

  it('shows_empty_state_when_no_cards_with_due', async () => {
    mockApiRoutes({ month: { ...mockCards, items: [] } })
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByText(/本月無到期卡片/)).toBeInTheDocument()
    })
  })
})

describe('CalendarTab 更多 popover', () => {
  const mkCard = (id: string, title: string): ProjectCardItem => ({
    id, title,
    boardId: 'b1', boardName: '看板', listId: 'l1', listName: '待辦',
    dueAt: `${YEAR}-${MM}-15T00:00:00Z`,
    isOverdue: false, isArchived: false,
    assignees: [], labelNames: [],
    estimatedHours: null, loggedHours: 0,
    checklistProgress: { total: 0, completed: 0 },
    reviewState: null,
  })
  const fiveSameDay: { items: ProjectCardItem[]; total: number; page: number; pageSize: number } = {
    items: [
      // c1 與 c4 帶 completedAt（完成打勾 `✓` 的兩個落點各要一張有值的卡，
      // 另外兩張——c2 與 c5——保持無值當對照）；c4 的 reviewState 是 popover
      // 分支的唯一守門員，維持原樣。
      { ...mkCard('c1', '正常卡片'), completedAt: `${YEAR}-${MM}-10T00:00:00Z` },
      mkCard('c2', '第二張卡'),
      mkCard('c3', '第三張卡'),
      { ...mkCard('c4', '第四張卡'), reviewState: 'pending', completedAt: `${YEAR}-${MM}-10T00:00:00Z` },
      mkCard('c5', '第五張卡'),
    ],
    total: 5, page: 1, pageSize: 200,
  }
  const cardC4 = {
    id: 'c4', listId: 'l1', title: '第四張卡', description: '', position: 'h',
    isArchived: false, dueAt: `${YEAR}-${MM}-15T00:00:00Z`, estimatedHours: null, coverAttachmentId: null,
    createdById: 'u1', createdAt: '2026-08-15T00:00:00Z', updatedAt: '2026-08-15T00:00:00Z',
    members: [], labels: [], checklists: [],
    activity: [], attachments: [], customFields: [], reviews: [],
    effort: { logs: [], totalHours: 0 }, mindMapNodes: [],
  }

  beforeEach(() => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/projects/p1/permissions/mine')
        return Promise.resolve({ data: ['card.edit', 'card.read'] })
      if (url.startsWith('/cards/c4')) return Promise.resolve({ data: cardC4 })
      // 分流鍵是 `hasDue=false`（不是 `pageSize=100`）。用舊鍵的話這裡會落到最後那行
      // `{ data: [] }` ⇒ `items` 是 undefined ⇒ `?? []` 靜默接住 ⇒ 側欄變空而**測試照綠**。
      if (url.includes('hasDue=false'))
        return Promise.resolve({ data: { items: [mockCards.items[2]], total: 1 } })
      if (url.includes('dueFrom')) return Promise.resolve({ data: fiveSameDay })
      return Promise.resolve({ data: [] })
    })
  })

  it('同日超過三張出現 +N 更多按鈕，隱藏卡片不在格子內', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+2 更多' })).toBeInTheDocument()
      expect(screen.getByText('正常卡片')).toBeInTheDocument()
    })
    expect(screen.queryByText('第四張卡')).not.toBeInTheDocument()
  })

  it('點開更多列出隱藏卡片，點擊開啟 CardDialog', async () => {
    render(
      <MemoryRouter>
        <CalendarTab projectId="p1" canEdit={false} />
      </MemoryRouter>,
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '+2 更多' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '+2 更多' }))
    await waitFor(() => {
      expect(screen.getByText('第四張卡')).toBeInTheDocument()
      expect(screen.getByText('第五張卡')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('第四張卡'))
    await waitFor(() => expect(screen.getByDisplayValue('第四張卡')).toBeInTheDocument())
  })

  it('popover 內的隱藏卡片顯示審查狀態圖示', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => expect(screen.getByRole('button', { name: '+2 更多' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '+2 更多' }))
    // 查詢**限定在 popover 內**：原本用的是全域的 `screen.findByLabelText`，判別力
    // 完全由 fixture 提供（只有 c4 帶狀態、而 c4 只在 popover 出現）——格子裡任一張卡
    // 也帶狀態時，這條在 popover 分支被拆掉之後照樣綠。Radix 的 PopoverContent 帶
    // `role="dialog"`（實查 `@radix-ui/react-popover@1.1.23` 的 dist：`role: "dialog"`）。
    const popover = await screen.findByRole('dialog')
    expect(await within(popover).findByLabelText('審查狀態：待審查')).toBeInTheDocument()
  })

  // 完成打勾 `✓` 的兩個落點（格子晶片、popover 列）是兩個獨立的渲染分支，各一條。
  // 那個 `✓` 是一個純文字的 `<span>`，**沒有任何無障礙名稱**，所以只能用文字查詢
  // ——不要為了讓斷言好寫而在元件上補 `aria-label`（那會牽動語系檔與 parity 閘門，
  // 屬另一條契約）。兩條都用 `within(那一列)` 限定範圍：`✓` 在畫面上不只一個。
  it('格子的卡片：completedAt 有值顯示 ✓、為 null 不顯示', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    const completedChip = (await screen.findByText('正常卡片')).closest('button') as HTMLElement
    expect(within(completedChip).getByText('✓')).toBeInTheDocument()
    const openChip = screen.getByText('第二張卡').closest('button') as HTMLElement
    expect(within(openChip).queryByText('✓')).not.toBeInTheDocument()
  })

  it('popover 內的卡片：completedAt 有值顯示 ✓、為 null 不顯示', async () => {
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })
    await waitFor(() => expect(screen.getByRole('button', { name: '+2 更多' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '+2 更多' }))
    const popover = await screen.findByRole('dialog')
    const completedRow = within(popover).getByText('第四張卡').closest('button') as HTMLElement
    expect(within(completedRow).getByText('✓')).toBeInTheDocument()
    const openRow = within(popover).getByText('第五張卡').closest('button') as HTMLElement
    expect(within(openRow).queryByText('✓')).not.toBeInTheDocument()
  })
})

describe('CalendarTab 的審查狀態圖示', () => {
  const withReviewState = (reviewState: 'pending' | 'approved' | 'rejected' | null) => ({
    items: [{ ...mockCards.items[0], reviewState }], total: 1, page: 1, pageSize: 200,
  })

  it.each<['pending' | 'approved' | 'rejected', string]>([
    ['pending', '審查狀態：待審查'],
    ['approved', '審查狀態：通過'],
    ['rejected', '審查狀態：退回'],
  ])('reviewState=%s 時圖示的無障礙名稱是 %s', async (reviewState, label) => {
    mockApiRoutes({ month: withReviewState(reviewState) });
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    expect(await screen.findByLabelText(label)).toBeInTheDocument();
  });

  it('reviewState 為 null 時不顯示審查狀態圖示', async () => {
    mockApiRoutes({ month: withReviewState(null) });
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    await screen.findByText('正常卡片');
    expect(screen.queryByLabelText(/^審查狀態：/)).not.toBeInTheDocument();
  });

  // 跨視圖一致性（本階段四個落點的最終契約）。四個視圖共用 `lib/review-badge.ts`，
  // 但**共用不是斷言**——任何一個落點自己接死字串、或接到別的 key，四道閘門都不會響
  // （它們比的是後端常數、前端 switch 與語系檔，不看呼叫端接對沒有）。
  // 月曆（與甘特、心智圖）走**無障礙名稱**：`findByLabelText` 的字串比對是精確比對，
  // 所以下面那一行同時釘住「前綴」「狀態詞」與「沒有多餘字元」。
  // 上面兩條斷言是**來源**（釘住共用的鍵與樣板），第三條是畫面、刻意寫字面值。
  // 判別力在第三條：實測（2026-09-17）只留第三條並把 zh-TW 的 rejected 譯文改壞，
  // 這支當場紅——來源那兩條的價值是失敗時直接指出契約的來源是哪一環。
  // 三支圖示視圖的斷言逐字相同——四個檔案裡的那個字面值必須一起改，否則其中一支當場紅。
  it('rejected 的圖示無障礙名稱逐字等於審查狀態：退回', async () => {
    mockApiRoutes({ month: withReviewState('rejected') });
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    expect(i18n.t('common:state.rejected')).toBe('退回');
    expect(i18n.t('common:reviewStatus.tooltip', { status: '退回' })).toBe('審查狀態：退回');
    expect(await screen.findByLabelText('審查狀態：退回')).toBeInTheDocument();
  });
});

// 靜默截斷的回歸測試（與 TableTab、GanttTab 同型）。月視圖的查詢 pageSize 上限是 500
// （`ProjectCardEndpoints` 硬擋 >500）而沒有分頁 UI ⇒ 一個月超過 500 張到期卡時，
// 格線讀起來像「這個月只有這些」。
//
// **兩支成對，判別力在第二支**：只寫「截斷時要顯示」的話，「無條件顯示」也照樣綠。
// 這個 describe 是上面那些的**兄弟**，繼承不到它們的 beforeEach ⇒ 自己設定分流。
describe('CalendarTab 的截斷提示', () => {
  const loaded = mockCards.items.length

  const mockMonthTotal = (total: number) => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/projects/p1/permissions/mine')
        return Promise.resolve({ data: ['card.edit', 'card.read'] })
      // 側欄固定在「不截斷」（0 == 0）：這一組測的是**月**的提示，共用同一句文案
      // ⇒ 側欄若也截斷，`queryByText(/僅載入前/)` 那支的「找不到」就會變成假紅。
      if (url.includes('hasDue=false'))
        return Promise.resolve({ data: { items: [], total: 0 } })
      if (url.includes('dueFrom')) return Promise.resolve({ data: { ...mockCards, total } })
      return Promise.resolve({ data: [] })
    })
  }

  it('total 大於已載入筆數時，提示同時印出總數與已載入筆數', async () => {
    mockMonthTotal(loaded + 598)
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })

    expect(
      await screen.findByText(`共 ${loaded + 598} 筆，僅載入前 ${loaded} 筆`)
    ).toBeInTheDocument()
  })

  it('total 等於已載入筆數時不顯示提示', async () => {
    mockMonthTotal(loaded)
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })

    // 先等一個**資料相依**的內容渲染出來——少了這一步，「找不到提示」可能只是還沒載入
    expect(await screen.findByText('正常卡片')).toBeInTheDocument()
    expect(screen.queryByText(/僅載入前/)).not.toBeInTheDocument()
  })
})

// 「無到期日」側欄的截斷提示。它與上面那一組是**不同的查詢**（`hasDue=false`），
// 但共用同一句文案 ⇒ 兩組測試都必須把另一邊釘在「不截斷」，否則 `findByText` 會撈到
// 隔壁那一條，而 `queryByText` 的「找不到」也會因為隔壁而變成假紅。
//
// 這裡的月查詢刻意回 `mockCards`（total 3 ＝ items 3，不截斷），只有面板截斷。
//
// ★ 面板卡片的標題**不能沿用 `mockCards.items[2]`**：那一張叫「無截止日」，
// 而 zh-TW 的 `project:calendar.noDue.empty` **逐字就是「無截止日」**
// ⇒ 「先等一個資料相依的元素」會等到**空狀態**，於是負向那支在面板整個壞掉時照樣綠。
describe('CalendarTab 無到期日側欄的截斷提示', () => {
  const panelCard: ProjectCardItem = { ...mockCards.items[2], id: 'p1', title: '面板卡片' }

  const mockPanel = (items: ProjectCardItem[], total: number) => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/projects/p1/permissions/mine')
        return Promise.resolve({ data: ['card.edit', 'card.read'] })
      if (url.includes('hasDue=false'))
        return Promise.resolve({ data: { items, total } })
      if (url.includes('dueFrom')) return Promise.resolve({ data: mockCards })
      return Promise.resolve({ data: [] })
    })
  }

  it('面板 total 大於載入筆數時印出提示', async () => {
    mockPanel([panelCard], 42)
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })

    expect(await screen.findByText('共 42 筆，僅載入前 1 筆')).toBeInTheDocument()
  })

  it('面板 total 等於載入筆數時不顯示提示', async () => {
    mockPanel([panelCard], 1)
    render(<CalendarTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() })

    // 資料相依的錨點：先確認面板**真的渲染了那一張卡**（不是空狀態、不是還沒載入）
    expect(await screen.findByText('面板卡片')).toBeInTheDocument()
    expect(screen.queryByText(/僅載入前/)).not.toBeInTheDocument()
  })
})
