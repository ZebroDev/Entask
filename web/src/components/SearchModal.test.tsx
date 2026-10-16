import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SearchModal } from './SearchModal'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../lib/api'
import { axiosStatus } from '../test/http-errors'
import type { Mock } from 'vitest'

const makeWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  )
}

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }))

const mockResults = {
  cards: [{ id: 'c1', title: '測試卡片', boardName: '看板', listName: '待辦', dueAt: null, isOverdue: false, highlight: '...測試...' }],
  comments: [],
  nodes: [{ nodeId: 'n1', title: '測試節點', note: null, cardId: null, cardTitle: null, highlight: '...測試...' }],
}

describe('SearchModal', () => {
  beforeEach(() => {
    (api.get as Mock).mockResolvedValue({ data: mockResults })
  })

  it('opens_on_ctrl_k', () => {
    render(<SearchModal projectId="p1" />, { wrapper: makeWrapper() })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does_not_search_with_single_char', async () => {
    render(<SearchModal projectId="p1" />, { wrapper: makeWrapper() })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'a' } })
    await waitFor(() => {
      expect(api.get).not.toHaveBeenCalled()
    })
    expect(screen.getByText(/至少 2 個字元/)).toBeInTheDocument()
  })

  it('shows_grouped_results', async () => {
    render(<SearchModal projectId="p1" />, { wrapper: makeWrapper() })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '測試' } })
    await waitFor(() => {
      expect(screen.getByText('測試卡片')).toBeInTheDocument()
      expect(screen.getByText('測試節點')).toBeInTheDocument()
    })
  })

  it('closes_on_esc', () => {
    render(<SearchModal projectId="p1" />, { wrapper: makeWrapper() })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('navigates_to_card_on_result_click', async () => {
    const onNavigate = vi.fn()
    render(<SearchModal projectId="p1" onNavigate={onNavigate} />, { wrapper: makeWrapper() })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '測試' } })
    await waitFor(() => screen.getByText('測試卡片'))
    fireEvent.click(screen.getByText('測試卡片'))
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ type: 'card', id: 'c1' }))
  })

  it('shows_board_and_list_names_in_card_results', async () => {
    render(<SearchModal projectId="p1" />, { wrapper: makeWrapper() })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '測試' } })
    await waitFor(() => {
      expect(screen.getByText('看板 / 待辦')).toBeInTheDocument()
    })
  })

  // 逾額（429）是**設計出來的行為**，不是例外狀況 ⇒ 它的畫面不能是空狀態。
  // 少了 error 分支時，失敗的回應與「查到了但沒有結果」都走 `items.length === 0`
  // ⇒ 畫面印出「無搜尋結果」——那是**錯的事實**（專案裡可能有一堆相符的卡片）。
  // ★ fixture 用 `axiosStatus`（body 帶 `{code, message}`）：`apiErrorMessage` 走的是
  // **錯誤碼的譯文**那條分支。body 的 `message` 刻意與譯文不同，三種實作才分得開
  // （見 `src/test/http-errors.ts` 的檔頭）。
  it('shows_rate_limit_message_instead_of_empty_state', async () => {
    (api.get as Mock).mockRejectedValue(
      axiosStatus(429, { code: 'request.tooManyRequests', message: 'SERVER-RAW' }),
    )
    render(<SearchModal projectId="p1" />, { wrapper: makeWrapper() })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '測試' } })
    await waitFor(() => expect(screen.getByText('請求過於頻繁，請稍後再試')).toBeInTheDocument())
    // 反向對照：沒有這個分支時，這裡印的會是空狀態那一句。
    expect(screen.queryByText('無搜尋結果')).not.toBeInTheDocument()
  })

  it('supports_keyboard_navigation_in_global_mode', async () => {
    (api.get as Mock).mockResolvedValue({
      data: [
        { id: 'p1', name: '專案一' },
        { id: 'p2', name: '專案二' },
      ],
    })
    render(<SearchModal open={true} />, { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(screen.getByText('專案一')).toBeInTheDocument()
    })
    const input = screen.getByRole('textbox')
    const item1 = screen.getByText('專案一').closest('div[class*="cursor-pointer"]')
    const item2 = screen.getByText('專案二').closest('div[class*="cursor-pointer"]')
    expect(item1).toHaveClass('bg-muted')
    expect(item2).not.toHaveClass('bg-muted')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(item1).not.toHaveClass('bg-muted')
    expect(item2).toHaveClass('bg-muted')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(item1).toHaveClass('bg-muted')
    expect(item2).not.toHaveClass('bg-muted')
  })
})
