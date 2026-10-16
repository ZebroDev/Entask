// 型別化 key：resources 由 zh-TW 的實際內容推導，所以呼叫端把 key 打錯會在
// `tsc -b` 就紅，不必等 runtime 才發現。P-B2 逐 namespace 抽字串時，這道防線
// 讓「打錯 key」不可能進到測試之外。
//
// 新增語系不需要改這裡——key 的權威是來源語系（zh-TW）。
//
// 空 namespace（骨架階段）宣告成 {} 是刻意的：在該 namespace 還沒有 key 之前，
// 任何引用它的呼叫端都一律型別錯誤。這讓「先寫呼叫端、忘了填語系檔」在編譯期就擋下來。
//
// 注意本檔的註解一律不寫出「帶引號的 t 呼叫」——i18next-parser 的 lexer 會把註解裡
// 那樣的寫法當成真呼叫而產生幽靈 key。詳見 i18next-parser.config.js 的 input 註解。
import "i18next";
import type admin from "./locales/zh-TW/admin.json";
import type auth from "./locales/zh-TW/auth.json";
import type board from "./locales/zh-TW/board.json";
import type card from "./locales/zh-TW/card.json";
import type common from "./locales/zh-TW/common.json";
import type error from "./locales/zh-TW/error.json";
import type me from "./locales/zh-TW/me.json";
import type permission from "./locales/zh-TW/permission.json";
import type project from "./locales/zh-TW/project.json";
import type team from "./locales/zh-TW/team.json";
import type workcalendar from "./locales/zh-TW/workcalendar.json";
import type worklog from "./locales/zh-TW/worklog.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      admin: typeof admin;
      common: typeof common;
      auth: typeof auth;
      me: typeof me;
      board: typeof board;
      card: typeof card;
      project: typeof project;
      team: typeof team;
      workcalendar: typeof workcalendar;
      worklog: typeof worklog;
      error: typeof error;
      permission: typeof permission;
    };
  }
}
