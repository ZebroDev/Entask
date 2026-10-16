// 語系資源的組裝點。每個 namespace 一個 JSON，每個語系一份。
//
// 這裡是 namespace 清單的權威：i18next.d.ts 的型別宣告、i18next-parser.config.js 的
// 抽取範圍、scripts/check-locale-parity.mjs 的比對清單都對應到它。新增 namespace 時
// 兩邊語系都要加——只有一邊的話 CI 會紅（該檢查會讀這個檔案，見其註解）。
//
// 資源靜態內嵌而非走 backend：首次 render 前就緒，沒有語系 FOUC。
import enAdmin from "./locales/en/admin.json";
import enAuth from "./locales/en/auth.json";
import enBoard from "./locales/en/board.json";
import enCard from "./locales/en/card.json";
import enCommon from "./locales/en/common.json";
import enError from "./locales/en/error.json";
import enMe from "./locales/en/me.json";
import enPermission from "./locales/en/permission.json";
import enProject from "./locales/en/project.json";
import enTeam from "./locales/en/team.json";
import enWorkcalendar from "./locales/en/workcalendar.json";
import enWorklog from "./locales/en/worklog.json";
import es419Admin from "./locales/es-419/admin.json";
import es419Auth from "./locales/es-419/auth.json";
import es419Board from "./locales/es-419/board.json";
import es419Card from "./locales/es-419/card.json";
import es419Common from "./locales/es-419/common.json";
import es419Error from "./locales/es-419/error.json";
import es419Me from "./locales/es-419/me.json";
import es419Permission from "./locales/es-419/permission.json";
import es419Project from "./locales/es-419/project.json";
import es419Team from "./locales/es-419/team.json";
import es419Workcalendar from "./locales/es-419/workcalendar.json";
import es419Worklog from "./locales/es-419/worklog.json";
import jaAdmin from "./locales/ja/admin.json";
import jaAuth from "./locales/ja/auth.json";
import jaBoard from "./locales/ja/board.json";
import jaCard from "./locales/ja/card.json";
import jaCommon from "./locales/ja/common.json";
import jaError from "./locales/ja/error.json";
import jaMe from "./locales/ja/me.json";
import jaPermission from "./locales/ja/permission.json";
import jaProject from "./locales/ja/project.json";
import jaTeam from "./locales/ja/team.json";
import jaWorkcalendar from "./locales/ja/workcalendar.json";
import jaWorklog from "./locales/ja/worklog.json";
import koAdmin from "./locales/ko/admin.json";
import koAuth from "./locales/ko/auth.json";
import koBoard from "./locales/ko/board.json";
import koCard from "./locales/ko/card.json";
import koCommon from "./locales/ko/common.json";
import koError from "./locales/ko/error.json";
import koMe from "./locales/ko/me.json";
import koPermission from "./locales/ko/permission.json";
import koProject from "./locales/ko/project.json";
import koTeam from "./locales/ko/team.json";
import koWorkcalendar from "./locales/ko/workcalendar.json";
import koWorklog from "./locales/ko/worklog.json";
import zhCNAdmin from "./locales/zh-CN/admin.json";
import zhCNAuth from "./locales/zh-CN/auth.json";
import zhCNBoard from "./locales/zh-CN/board.json";
import zhCNCard from "./locales/zh-CN/card.json";
import zhCNCommon from "./locales/zh-CN/common.json";
import zhCNError from "./locales/zh-CN/error.json";
import zhCNMe from "./locales/zh-CN/me.json";
import zhCNPermission from "./locales/zh-CN/permission.json";
import zhCNProject from "./locales/zh-CN/project.json";
import zhCNTeam from "./locales/zh-CN/team.json";
import zhCNWorkcalendar from "./locales/zh-CN/workcalendar.json";
import zhCNWorklog from "./locales/zh-CN/worklog.json";
import zhTWAdmin from "./locales/zh-TW/admin.json";
import zhTWAuth from "./locales/zh-TW/auth.json";
import zhTWBoard from "./locales/zh-TW/board.json";
import zhTWCard from "./locales/zh-TW/card.json";
import zhTWCommon from "./locales/zh-TW/common.json";
import zhTWError from "./locales/zh-TW/error.json";
import zhTWMe from "./locales/zh-TW/me.json";
import zhTWPermission from "./locales/zh-TW/permission.json";
import zhTWProject from "./locales/zh-TW/project.json";
import zhTWTeam from "./locales/zh-TW/team.json";
import zhTWWorkcalendar from "./locales/zh-TW/workcalendar.json";
import zhTWWorklog from "./locales/zh-TW/worklog.json";
import type { Resource } from "i18next";

/** 來源語系，也是 key 的權威（i18next.d.ts 的型別由它推導）。 */
const zhTW = {
  admin: zhTWAdmin,
  common: zhTWCommon,
  auth: zhTWAuth,
  me: zhTWMe,
  board: zhTWBoard,
  card: zhTWCard,
  project: zhTWProject,
  team: zhTWTeam,
  workcalendar: zhTWWorkcalendar,
  worklog: zhTWWorklog,
  error: zhTWError,
  permission: zhTWPermission,
};

/** 第二語系（D2）。譯文尚未經母語者審閱，性質見 locales/en/README.md。 */
const en = {
  admin: enAdmin,
  common: enCommon,
  auth: enAuth,
  me: enMe,
  board: enBoard,
  card: enCard,
  project: enProject,
  team: enTeam,
  workcalendar: enWorkcalendar,
  worklog: enWorklog,
  error: enError,
  permission: enPermission,
};

/**
 * 第四語系（拉美中性西語）。**唯一有 one／many／other 三個複數類別**的語系——
 * `many` 只在**整百萬**的數量上觸發（`Intl.PluralRules("es-419")`），
 * 所以它的葉節點數是「zh-TW 的葉節點 ＋ 2 × 複數族數」。譯文尚未經母語者審閱，
 * 見 locales/es-419/README.md。
 */
const es419 = {
  admin: es419Admin,
  common: es419Common,
  auth: es419Auth,
  me: es419Me,
  board: es419Board,
  card: es419Card,
  project: es419Project,
  team: es419Team,
  workcalendar: es419Workcalendar,
  worklog: es419Worklog,
  error: es419Error,
  permission: es419Permission,
};

/** 第五語系。譯文尚未經母語者審閱，性質見 locales/ja/README.md。 */
const ja = {
  admin: jaAdmin,
  common: jaCommon,
  auth: jaAuth,
  me: jaMe,
  board: jaBoard,
  card: jaCard,
  project: jaProject,
  team: jaTeam,
  workcalendar: jaWorkcalendar,
  worklog: jaWorklog,
  error: jaError,
  permission: jaPermission,
};

/** 第三語系。**由 zh-TW 轉換＋逐條審閱產生**，不是機轉。譯文尚未經母語者審閱，見 locales/zh-CN/README.md。 */
const zhCN = {
  admin: zhCNAdmin,
  common: zhCNCommon,
  auth: zhCNAuth,
  me: zhCNMe,
  board: zhCNBoard,
  card: zhCNCard,
  project: zhCNProject,
  team: zhCNTeam,
  workcalendar: zhCNWorkcalendar,
  worklog: zhCNWorklog,
  error: zhCNError,
  permission: zhCNPermission,
};

/** 第六語系。譯文尚未經母語者審閱，性質見 locales/ko/README.md。 */
const ko = {
  admin: koAdmin,
  common: koCommon,
  auth: koAuth,
  me: koMe,
  board: koBoard,
  card: koCard,
  project: koProject,
  team: koTeam,
  workcalendar: koWorkcalendar,
  worklog: koWorklog,
  error: koError,
  permission: koPermission,
};

export const resources: Resource = {
  // 鍵是字面 `"zh-TW"`，**刻意不跟 DEFAULT_LOCALE 走**（2026-10-07 它改 en 的那次）：
  // 這份 bundle 的身分是「來源語系的資源」——key 的權威、偽語系的變換來源——與「產品
  // 預設語系是哪一個」無關。跟著常數走的話，改預設語系會讓這個鍵與下面的 `en` 撞名
  // （後者勝），zh-TW 資源會靜默消失。
  "zh-TW": zhTW,
  en,
  "zh-CN": zhCN,
  "es-419": es419,
  ja,
  ko,
};
