// 對應後端 DTO（src/Entask.Api/Dtos/）：JSON 為 camelCase（ASP.NET Core Web 預設命名政策）

import type { ReviewState } from "./review-badge";

export interface ProjectResponse {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  memberCount: number;
  boardCount: number;
  createdAt: string;
}

export interface ProjectMemberRoleDto {
  id: string;
  name: string;
  /** 系統角色的穩定識別碼（`SystemRoleCodes` 的六個值）；**自訂角色是 `null`**。
   *
   * 選填是刻意的：`name` 才是資料（顯示名），`code` 只是「這是不是六個系統角色之一」的
   * 判準。少了它的來源（舊回應、測試 fixture）在型別上仍然成立，顯示端會退回 `name`
   * ——`roleNameLabel` 的 default 分支正是為此存在。 */
  code?: string | null;
}

export interface ProjectMemberResponse {
  userId: string;
  username: string;
  displayName: string;
  /** 後端有這個欄位（`ProjectDtos.cs` 的 `ProjectMemberResponse`），但**它一直是缺席的**：
   *  唯一的消費端（`BoardCard` 的頭像）在那之前把回應轉成 `any[]`，型別檢查看不到。
   *  拿掉那個 `as any[]` 之後這裡就必須補上，否則卡片頭像整批編不過。 */
  avatarUrl: string | null;
  roles?: ProjectMemberRoleDto[];
  roleIds: string[];
  /** 名冊**保留**停用者並加這個標記（設計 D7）：過濾掉會讓卡片頭像消失、且那個成員
   *  再也沒有移除的路徑。可指派池的排除是後端的事（`/auth/users`）。 */
  deactivated: boolean;
}

export interface BoardSummaryResponse {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  position: string;
  isArchived: boolean;
}

export interface BoardDetailResponse {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  position: string;
  isArchived: boolean;
  lists: ListResponse[];
}

export interface ListResponse {
  id: string;
  name: string;
  position: string;
  isArchived: boolean;
  cards: BoardCardResponse[];
}

export interface BoardCardResponse {
  id: string;
  listId: string;
  title: string;
  position: string;
  isArchived: boolean;
  startAt?: string | null;
  dueAt: string | null;
  completedAt?: string | null;
  coverAttachmentId: string | null;
  labels: string[];
  members: string[];
  checklistDone: number;
  checklistTotal: number;
  loggedHours: number;
  remainingHours: number | null;
  reviewState: ReviewState;
  isOverdue?: boolean;
}

export interface LabelResponse { id: string; name: string; color: string; position: string; }

export interface ChecklistItemResponse { id: string; text: string; isChecked: boolean; position: string; }

export interface ChecklistResponse { id: string; title: string; position: string; items: ChecklistItemResponse[]; }

export interface ActivityResponse {
  id: string;
  cardId: string;
  userId: string;
  username: string;
  displayName: string;
  type: string;
  text: string | null;
  detail: string | null;
  createdAt: string;
}

export interface CardFieldValueResponse { fieldDefinitionId: string; value: unknown; }

export interface ReviewResponse {
  id: string;
  reviewerUserId: string;
  reviewerUsername: string;
  reviewerDisplayName: string;
  status: string;
  score: number | null;
  comment: string | null;
  updatedAt: string;
}

/**
 * `GET /cards/{cardId}/review-history` 的一列（後端 `ReviewEntryResponse`）。
 *
 * **這個端點回的是裸陣列**，不是 `{ items, nextCursor }`——審查歷程是 append-only，
 * 刻意不做分頁，所以這裡沒有分頁型別。
 *
 * `reviewerUsername`／`reviewerDisplayName` 可能都是**空字串**：後端走兩步查 User
 * （Core 不可引用 Identity），查不到人時是 `u?.UserName ?? ""`。畫面不能假設它們有值。
 */
export interface ReviewEntryResponse {
  id: string;
  reviewerUserId: string;
  reviewerUsername: string;
  reviewerDisplayName: string;
  status: string;
  score: number | null;
  comment: string | null;
  createdAt: string;
}

export interface EffortLogResponse {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  hours: number;
  note: string | null;
  localDate: string;
}

export interface EffortListResponse { logs: EffortLogResponse[]; totalHours: number; }

export interface AttachmentResponse {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface CustomFieldResponse {
  id: string;
  scopeType: string;
  scopeId: string;
  name: string;
  type: string;
  options: string[] | null;
  position: string;
}

export interface CardResponse {
  id: string;
  listId: string;
  boardId?: string;
  title: string;
  description: string | null;
  position: string;
  isArchived: boolean;
  startAt?: string | null;
  dueAt: string | null;
  completedAt?: string | null;
  estimatedHours: number | null;
  coverAttachmentId: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  members: string[];
  labels: LabelResponse[];
  checklists: ChecklistResponse[];
  attachments: AttachmentResponse[];
  customFields: CardFieldValueResponse[];
  reviews: ReviewResponse[];
  reviewState: ReviewState;
  effort: EffortListResponse;
  mindMapNodes: MindMapNodeResponse[];
}

export interface ActivityPageResponse {
  items: ActivityResponse[];
  nextCursor: string | null;
}

export interface MindMapCardSummary { id: string; title: string; isArchived: boolean; completedAt: string | null; reviewState: ReviewState; }

export interface MindMapNodeResponse {
  id: string;
  parentId: string | null;
  title: string;
  note: string | null;
  position: string;
  positionX?: number | null;
  positionY?: number | null;
  cardId: string | null;
  card: MindMapCardSummary | null;
}

export interface MindMapResponse {
  id: string;
  projectId: string;
  name: string | null;
  nodes: MindMapNodeResponse[];
}

export interface MindMapCardLinkResponse { id: string; title: string; projectId: string; mindMapId: string; }

export interface MemberHoursRow { userId: string; username: string; displayName: string; hours: number; cardCount: number; }

export interface MemberRemainingRow {
  userId: string; username: string; displayName: string;
  estimatedHours: number; loggedHours: number; remainingHours: number;
}

export interface ReviewStats { pendingCount: number; approvedCount: number; rejectedCount: number; averageScore: number | null; }

export interface CardReportRow {
  id: string; title: string; boardId: string; boardName: string; listId: string; listName: string;
  assigneeUserIds: string[]; estimatedHours: number | null; loggedHours: number;
  remainingHours: number | null; reviewStatus: string | null; priority: string | null;
}

export interface ProjectReportResponse {
  memberHours: MemberHoursRow[];
  memberRemaining: MemberRemainingRow[];
  reviewStats: ReviewStats;
  cards: CardReportRow[];
  // 資料涵蓋的年份（由大到小）。**與團隊報表同源、同一個形狀**（同一個後端查詢）。
  // **選填**，與 `TeamReportResponse.availableYears` 的既有慣例一致：舊後端不帶這個欄位，
  // 缺席時退化為「今年 ∪ 選定年」——那正是團隊頁過去的行為，不是錯誤。
  // 後端**刻意不含今年**（判定「今年」要讀時鐘，而後端不得隱式判定年份）。
  availableYears?: number[];
}

export interface WorkLogEntry {
  logId: string;
  loggedAtLocal: string;
  hours: number;
  note: string | null;
  cardId: string;
  cardTitle: string;
  cardCompletedAt: string | null;
  cardEstimatedHours: number | null;
  teamName: string;
  projectId: string;
  projectName: string;
  boardId: string;
  boardName: string;
  listId: string;
  listName: string;
}

export interface WorkLogDay {
  date: string;          // yyyy-MM-dd（本地日）
  totalHours: number;
  entryCount: number;
  entries: WorkLogEntry[];
}

export interface WorkLogProjectSlice {
  projectId: string;
  projectName: string;
  hours: number;
  entryCount: number;
}

export interface WorkLogMember {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  totalHours: number;
  entryCount: number;
  cardCount: number;
  activeDays: number;
  reportedWorkdays: number;
  missingWorkdays: number;
  /** 漏報日的單一出處是後端（已依到職日 `JoinedAt` 夾擠）：`missingDays` 為升冪的
   *  本地 `yyyy-MM-dd`；分母 `expectedWorkdays` 是**該員**應填報的工作日數
   *  ——不是範圍級的 `workdays.length`。前端只渲染，不再自行推導。 */
  expectedWorkdays: number;
  missingDays: string[];
  completedCards: number;
  projects: WorkLogProjectSlice[];
  days: WorkLogDay[];
}

export interface WorkLogSummary {
  totalHours: number;
  memberCount: number;
  entryCount: number;
  cardCount: number;
  workdayCount: number;
}

export interface WorkLogReportResponse {
  scope: string;
  fromDate: string;
  toDate: string;
  workdays: string[];    // yyyy-MM-dd，升冪
  summary: WorkLogSummary;
  members: WorkLogMember[];
}

