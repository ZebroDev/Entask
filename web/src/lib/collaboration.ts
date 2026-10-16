import { useEffect, useRef } from "react";
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { useAuth } from "@/stores/auth";
import {
  useNotificationStore,
  type NotificationItem,
  type NotificationPush,
} from "@/lib/notificationStore";

export interface PresenceUser {
  userId: string;
  displayName: string;
  userName?: string;
}

interface PresenceState {
  boardUsers: Record<string, PresenceUser[]>;
  setBoardUsers: (boardId: string, users: PresenceUser[]) => void;
  connectionState: HubConnectionState;
  setConnectionState: (state: HubConnectionState) => void;
  /** 每次建立新 HubConnection 遞增——useCollaboration effect 依賴它以重綁 handler */
  connectionEpoch: number;
  bumpConnectionEpoch: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  boardUsers: {},
  connectionState: HubConnectionState.Disconnected,
  setBoardUsers: (boardId, users) =>
    set((state) => ({
      boardUsers: { ...state.boardUsers, [boardId]: users },
    })),
  setConnectionState: (connectionState) => set({ connectionState }),
  connectionEpoch: 0,
  bumpConnectionEpoch: () => set((state) => ({ connectionEpoch: state.connectionEpoch + 1 })),
}));

let globalConnection: HubConnection | null = null;
let connectionPromise: Promise<HubConnection> | null = null;
/** 目前掛載中的 useCollaboration 所屬 queryClient——重連/重試路徑沒有 hook context，透過 getter 取用 */
let activeQueryClient: QueryClient | null = null;
/** 目前已加入的群組（含多個掛載 hook 的聯集），重連後自動 rejoin */
const joinedGroups: { boards: Set<string>; projects: Set<string> } = {
  boards: new Set(),
  projects: new Set(),
};

export function getCollaborationHub(token?: string | null): Promise<HubConnection> {
  if (globalConnection && globalConnection.state === HubConnectionState.Connected) {
    return Promise.resolve(globalConnection);
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  const effectiveToken = token ?? useAuth.getState().tokens?.accessToken;
  if (!effectiveToken) {
    return Promise.reject(new Error("No access token for SignalR connection"));
  }

  const connection = new HubConnectionBuilder()
    .withUrl("/hubs/collaboration", {
      accessTokenFactory: () => useAuth.getState().tokens?.accessToken ?? "",
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(LogLevel.Warning)
    .build();

  globalConnection = connection;
  usePresenceStore.getState().bumpConnectionEpoch();
  usePresenceStore.getState().setConnectionState(connection.state);

  connection.onreconnecting(() => {
    usePresenceStore.getState().setConnectionState(HubConnectionState.Reconnecting);
  });

  connection.onreconnected(async () => {
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
    // 重連後：伺服器 group 成員以 connectionId 綁定已失效——先 rejoin，
    // 再全量重校（P10 階段三承諾：連線恢復後最新資料已同步）。
    const groups = [...joinedGroups.boards].map((id) =>
      connection.invoke("JoinBoard", id).catch(() => {}),
    );
    groups.push(...[...joinedGroups.projects].map((id) =>
      connection.invoke("JoinProject", id).catch(() => {}),
    ));
    await Promise.all(groups);
    await activeQueryClient?.invalidateQueries();
  });

  connection.onclose(() => {
    usePresenceStore.getState().setConnectionState(HubConnectionState.Disconnected);
    globalConnection = null;
    connectionPromise = null;
  });

  connectionPromise = connection
    .start()
    .then(() => {
      usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
      return connection;
    })
    .catch((err) => {
      globalConnection = null;
      connectionPromise = null;
      usePresenceStore.getState().setConnectionState(HubConnectionState.Disconnected);
      throw err;
    });

  return connectionPromise;
}

/** 停止協作連線（登出時呼叫）：離開全部群組、停止連線、清空 presence */
export function stopCollaboration(): void {
  const conn = globalConnection;
  if (conn) {
    for (const boardId of joinedGroups.boards) {
      conn.invoke("LeaveBoard", boardId).catch(() => {});
    }
    for (const projectId of joinedGroups.projects) {
      conn.invoke("LeaveProject", projectId).catch(() => {});
    }
    conn.stop().catch(() => {});
  }
  joinedGroups.boards.clear();
  joinedGroups.projects.clear();
  globalConnection = null;
  connectionPromise = null;
  usePresenceStore.setState({
    boardUsers: {},
    connectionState: HubConnectionState.Disconnected,
  });
}

/** 同一 card 事件於 board＋project 雙群組各收一份——短窗去重避免雙倍 invalidate 風暴 */
const lastEventAt = new Map<string, number>();
function dedupEvent(key: string, windowMs = 300): boolean {
  const now = Date.now();
  const prev = lastEventAt.get(key);
  if (prev !== undefined && now - prev < windowMs) return true;
  lastEventAt.set(key, now);
  return false;
}

/**
 * 卡片事件受影響的 query key 集合（含 my-work 跨專案工作台與月曆無到期側欄）。
 *
 * **這裡是卡片事件失效的單一集中點**：`CardCreated`／`CardUpdated`／`CardMoved`／
 * `CardDeleted` 四個 handler 全部呼叫這一支，所以「隨卡片事件變動」的 query 該加在
 * 這裡，不是各自的 handler。漏掉一條不會有任何紅燈——那個查詢只會在別人的操作之後
 * 停在舊資料上（審查歷程就是這樣漏掉的，見 Task 7 review 的 M-1）。
 *
 * 只回傳 key、不碰 queryClient，是為了讓它能在單元測試裡直接斷言：實際的
 * `invalidateQueries` 迴圈沒有任何便宜的測法（要為它做一個 signalr 假物件），
 * 而**清單本身才是會漏東西的地方**（實測：刪掉 `card-review-history` 那一條，
 * 全量 1694 支測試全綠）。見 `collaboration.test.ts`。
 */
export function cardEventQueryKeys(data: { boardId: string; projectId: string; cardId: string }) {
  return [
    ["board", data.boardId],
    ["project-cards-table", data.projectId],
    ["project-cards", data.projectId],
    ["project-cards-nodue", data.projectId],
    ["card", data.cardId],
    // 審查歷程是 append-only 的留痕，與 `["card", id]` 是**兩個 key**——前綴比對逐元素，
    // `["card"]` 匹配不到它（Task 7 fix round 1：自己提交的那條路在 ItemDetailsTab，
    // 別人提交的那條路在這裡）。
    ["card-review-history", data.cardId],
    ["mindmap", data.projectId],
    ["report", data.projectId],
    ["worklog"],
    ["my-work"],
  ] as const;
}

function invalidateCardQueries(
  queryClient: QueryClient,
  data: { boardId: string; projectId: string; cardId: string },
) {
  for (const queryKey of cardEventQueryKeys(data)) {
    queryClient.invalidateQueries({ queryKey });
  }
}

/** 於 connection 上註冊事件 handler（可重入：off 後 on） */
function ensureHandlers(conn: HubConnection, queryClient: QueryClient): void {
  conn.off("CardCreated");
  conn.on("CardCreated", (data: { cardId: string; listId: string; boardId: string; projectId: string }) => {
    if (dedupEvent(`CardCreated:${data.cardId}`)) return;
    invalidateCardQueries(queryClient, data);
  });

  conn.off("CardUpdated");
  conn.on("CardUpdated", (data: { cardId: string; boardId: string; projectId: string; action?: string }) => {
    if (dedupEvent(`CardUpdated:${data.cardId}`)) return;
    invalidateCardQueries(queryClient, data);
  });

  conn.off("CardMoved");
  conn.on("CardMoved", (data: { cardId: string; listId: string; position: string; sourceListId?: string; boardId: string; projectId: string }) => {
    if (dedupEvent(`CardMoved:${data.cardId}`)) return;
    invalidateCardQueries(queryClient, data);
  });

  conn.off("CardDeleted");
  conn.on("CardDeleted", (data: { cardId: string; boardId: string; projectId: string }) => {
    if (dedupEvent(`CardDeleted:${data.cardId}`)) return;
    invalidateCardQueries(queryClient, data);
  });

  conn.off("MindMapUpdated");
  conn.on("MindMapUpdated", (data: { projectId: string; action: string }) => {
    queryClient.invalidateQueries({ queryKey: ["mindmap", data.projectId] });
  });

  conn.off("NotificationReceived");
  // 型別來源是 `NotificationPush`（store 的 `NotificationItem` 的 Partial）而不是在這裡
  // 手寫一份 union——舊的手寫版本漏了 `assigned`，而 SignalR 的酬載不經 TS 檢查，
  // 所以那個缺口不會有任何紅燈。
  conn.on("NotificationReceived", (item: NotificationPush) => {
    useNotificationStore.getState().addNotification({
      ...item,
      id: item.id || String(Date.now()),
      createdAt: item.createdAt || new Date().toISOString(),
      read: item.read ?? false,
    } as NotificationItem);
  });

  conn.off("BoardPresenceChanged");
  conn.on("BoardPresenceChanged", (data: { boardId: string; users: PresenceUser[] }) => {
    usePresenceStore.getState().setBoardUsers(data.boardId, data.users);
  });
}

const EMPTY_USERS: PresenceUser[] = [];

/**
 * Hook to participate in real-time SignalR collaboration for a board and/or project.
 */
export function useCollaboration(options?: { boardId?: string; projectId?: string }) {
  const queryClient = useQueryClient();
  const token = useAuth((state) => state.tokens?.accessToken);
  const activeBoardId = options?.boardId;
  const activeProjectId = options?.projectId;
  const connectionEpoch = usePresenceStore((state) => state.connectionEpoch);
  const presenceUsers = usePresenceStore((state) =>
    activeBoardId && state.boardUsers[activeBoardId]
      ? state.boardUsers[activeBoardId]
      : EMPTY_USERS
  );

  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!token) return;

    let isMounted = true;
    activeQueryClient = queryClient;

    getCollaborationHub(token)
      .then((conn) => {
        if (!isMounted) return;

        // 每個 connection 實例註冊一次 handler（epoch 遞增時對新連線重綁）
        ensureHandlers(conn, queryClient);

        // Join active board
        if (activeBoardId && conn.state === HubConnectionState.Connected) {
          joinedGroups.boards.add(activeBoardId);
          conn.invoke("JoinBoard", activeBoardId).catch(console.error);
        }
        // Join active project
        if (activeProjectId && conn.state === HubConnectionState.Connected) {
          joinedGroups.projects.add(activeProjectId);
          conn.invoke("JoinProject", activeProjectId).catch(console.error);
        }
      })
      .catch((err) => {
        // Silently handle initial connection delay or test environments
        console.warn("SignalR hub connection error:", err);
      });

    return () => {
      isMounted = false;
      if (activeBoardId) {
        joinedGroups.boards.delete(activeBoardId);
        if (globalConnection && globalConnection.state === HubConnectionState.Connected) {
          globalConnection.invoke("LeaveBoard", activeBoardId).catch(() => {});
        }
      }
      if (activeProjectId) {
        joinedGroups.projects.delete(activeProjectId);
        if (globalConnection && globalConnection.state === HubConnectionState.Connected) {
          globalConnection.invoke("LeaveProject", activeProjectId).catch(() => {});
        }
      }
    };
  }, [token, activeBoardId, activeProjectId, queryClient, connectionEpoch]);

  return { presenceUsers };
}
