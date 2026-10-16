import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5088",
      "/hubs": {
        target: "http://localhost:5088",
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    // `css: true` 是為了 `src/lib/review-badge.test.ts` 的那條匯出底色契約：它用 `?raw`
    // 讀 `index.css` 的 `--destructive`（匯出的紅必須跟著 CSS 變數走）。預設的 `css: false`
    // 把 CSS 換成**空模組**——`?raw` 也一樣，拿到的是空字串（實測 `cssText.length === 0`），
    // 於是「找不到 `:root` 區塊」會紅，但紅的理由指向錯的方向。今天只有那一個測試檔匯入 CSS。
    css: true,
    globals: true,
    // 順序有意義，不可對調：locale-pin 把 navigator.languages 釘成 zh-TW，
    // 必須在 setup.ts 匯入 @/i18n（模組載入時就解析語系）之前執行。
    // 兩者不能合併成一個檔案——合併後 import i18n 會被 ES module 的匯入提升搶先。
    // 少了這個順序，386 支中文斷言會全部以英文啟動。見 src/test/locale-pin.ts。
    setupFiles: ["src/test/locale-pin.ts", "src/test/setup.ts"],
  },
});
