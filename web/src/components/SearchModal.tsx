import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { apiErrorMessage } from '@/lib/utils'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Search, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface NavigateTarget {
  type: 'card' | 'board' | 'mindmap_node'
  id: string
  boardId?: string
}

interface SearchModalProps {
  onNavigate?: (target: NavigateTarget) => void;
  projectId?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

interface SearchResponse {
  cards: any[]
  comments: any[]
  nodes: any[]
}

export function SearchModal({ projectId, open: controlledOpen, onOpenChange, onNavigate }: SearchModalProps) {
  const { t } = useTranslation(['common'])
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen
  const setOpen = onOpenChange || setInternalOpen
  
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        // 輸入焦點守護（與 C/F/? 快捷鍵一致）：input/textarea/select/contentEditable 內不觸發，
        // 避免打字時彈出搜尋、或在搜尋框內再按 Ctrl+K 把視窗關掉
        const target = e.target as HTMLElement | null
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
        ) {
          return
        }
        e.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setOpen])

  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  // `error` 必須解構出來（2026-09-24 複閱的 M-2）。少了它，失敗的回應與「查到了、但沒有結果」
  // 在畫面上長得一模一樣——而本批開始，這個端點有一個**正常的**失敗模式（429 逾額，見
  // `RateLimitPolicy`）⇒ 使用者會讀到「找不到」這句**錯的事實**。逾額是設計出來的行為，
  // 不是例外狀況，所以它的畫面不能是空狀態。
  const { data, isLoading, error } = useQuery({
    queryKey: ['search', projectId, debouncedQuery],
    queryFn: async () => {
      if (!projectId || !debouncedQuery || debouncedQuery.length < 2) return { cards: [], comments: [], nodes: [] }
      const res = await api.get(`/projects/${projectId}/search?q=${encodeURIComponent(debouncedQuery)}`)
      return res.data as SearchResponse
    },
    enabled: !!projectId && debouncedQuery.length >= 2,
    staleTime: 30000,
  })

  const [selectedIndex, setSelectedIndex] = useState(0)
  const [globalSelectedIndex, setGlobalSelectedIndex] = useState(0)

  useEffect(() => {
    setGlobalSelectedIndex(0)
  }, [query, open])
  const items = [
    ...(data?.cards?.map(c => ({ ...c, type: 'card' })) || []),
    ...(data?.comments?.map(c => ({ ...c, type: 'comment' })) || []),
    ...(data?.nodes?.map(m => ({ ...m, type: 'mindmap', id: m.nodeId || m.id })) || [])
  ]

  useEffect(() => {
    setSelectedIndex(0)
  }, [data])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && items.length > 0) {
      e.preventDefault()
      const item = items[selectedIndex]
      handleNavigate(item)
    }
  }

  const handleNavigate = (item: any) => {
    setOpen(false)
    if (onNavigate) {
      onNavigate({ ...item, type: item.type === 'mindmap' ? 'mindmap_node' : item.type })
      return
    }
    if (item.type === 'card' || item.type === 'comment') {
      navigate(`/projects/${projectId}/boards/${item.boardId}/cards/${item.cardId || item.id}`)
    } else if (item.type === 'mindmap') {
      navigate(`/projects/${projectId}?tab=mindmap&node=${item.id}`)
    }
  }

  const projectsQuery = useQuery({
    queryKey: ['my-projects-search'],
    queryFn: async () => (await api.get('/projects')).data as any[],
    enabled: !projectId && open,
  });

  if (!projectId) {
    const pList = (projectsQuery.data ?? []).filter((p: any) =>
      !query || p.name.toLowerCase().includes(query.toLowerCase())
    );

    const handleGlobalKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (pList.length > 0) {
          setGlobalSelectedIndex((i) => Math.min(i + 1, pList.length - 1));
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (pList.length > 0) {
          setGlobalSelectedIndex((i) => Math.max(i - 1, 0));
        }
      } else if (e.key === 'Enter' && pList.length > 0) {
        e.preventDefault();
        const selected = pList[globalSelectedIndex];
        if (selected) {
          setOpen(false);
          navigate(`/projects/${selected.id}`);
        }
      }
    };

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0 overflow-hidden max-w-2xl gap-0">
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <input
              className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              placeholder={t("common:search.projects.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleGlobalKeyDown}
              autoFocus
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
            <h3 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">{t("common:search.projects.heading", { count: pList.length })}</h3>
            {pList.map((p: any, index: number) => (
              <div
                key={p.id}
                className={`cursor-pointer rounded-md p-2 hover:bg-muted transition-colors flex items-center justify-between ${globalSelectedIndex === index ? 'bg-muted' : ''}`}
                onClick={() => {
                  setOpen(false);
                  navigate(`/projects/${p.id}`);
                }}
              >
                <div className="font-medium text-sm">{p.name}</div>
                <span className="text-xs text-muted-foreground">{t("common:search.open.hint")}</span>
              </div>
            ))}
            {pList.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">{t("common:search.projects.empty")}</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 overflow-hidden max-w-2xl gap-0">
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={t("common:search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {query.length > 0 && query.length < 2 && (
            <div className="p-4 text-center text-sm text-muted-foreground">{t("common:search.minLength")}</div>
          )}
          {isLoading && (
            <div className="p-4 text-center text-sm text-muted-foreground flex items-center justify-center">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("common:state.searching")}
            </div>
          )}
          {!isLoading && error && query.length >= 2 && debouncedQuery.length >= 2 && (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {apiErrorMessage(error, t("common:error.load"))}
            </div>
          )}
          {!isLoading && !error && query.length >= 2 && debouncedQuery.length >= 2 && items.length === 0 && (
            <div className="p-4 text-center text-sm text-muted-foreground">{t("common:search.empty")}</div>
          )}
          
          <div className="p-2 space-y-4">
            {data?.cards && data.cards.length > 0 && (
              <div>
                <h3 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">{t("common:search.cards.heading", { count: data.cards.length })}</h3>
                {data.cards.map((c) => {
                  const globalIndex = items.findIndex(item => item.id === c.id && item.type === 'card');
                  return (
                    <div 
                      key={c.id} 
                      className={`cursor-pointer rounded-md p-2 hover:bg-muted ${selectedIndex === globalIndex ? 'bg-muted' : ''}`}
                      onClick={() => handleNavigate({ ...c, type: 'card' })}
                    >
                      <div className="font-medium text-sm">{c.title}</div>
                      <div className="text-xs text-muted-foreground mt-1">{c.boardName} / {c.listName}</div>
                    </div>
                  )
                })}
              </div>
            )}
            
            {data?.comments && data.comments.length > 0 && (
              <div>
                <h3 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">{t("common:search.comments.heading", { count: data.comments.length })}</h3>
                {data.comments.map((c) => {
                  const globalIndex = items.findIndex(item => item.id === c.id && item.type === 'comment');
                  return (
                    <div 
                      key={c.id} 
                      className={`cursor-pointer rounded-md p-2 hover:bg-muted ${selectedIndex === globalIndex ? 'bg-muted' : ''}`}
                      onClick={() => handleNavigate({ ...c, type: 'comment' })}
                    >
                      <div className="font-medium text-sm">{t("common:search.comments.onCard", { title: c.cardTitle })}</div>
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.highlight || c.content}</div>
                    </div>
                  )
                })}
              </div>
            )}
            
            {data?.nodes && data.nodes.length > 0 && (
              <div>
                <h3 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">{t("common:search.nodes.heading", { count: data.nodes.length })}</h3>
                {data.nodes.map((n, i) => {
                  const globalIndex = items.findIndex(item => item.id === n.id && item.type === 'mindmap');
                  return (
                    <div 
                      key={n.id || n.nodeId || i} 
                      className={`cursor-pointer rounded-md p-2 hover:bg-muted ${selectedIndex === globalIndex ? 'bg-muted' : ''}`}
                      onClick={() => handleNavigate({ ...n, id: n.id || n.nodeId, type: 'mindmap' })}
                    >
                      <div className="font-medium text-sm">{n.title}</div>
                      {n.note && <div className="text-xs text-muted-foreground mt-1 line-clamp-1">{n.note}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}




