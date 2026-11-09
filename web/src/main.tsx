import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client";
import { Toaster } from "sonner";
import App from "./App";
import { ThemeProvider } from "./components/theme-provider";
import { registerAuthStorageSync, useAuth } from "./stores/auth";
import { THEME_STORAGE_KEY } from "./lib/storage-keys";
// 必須在 render 之前：資源內嵌且 init 同步，首次 render 就是正確語系（無 FOUC），
// 並在同步階段一併設好 document.documentElement.lang。
import { LanguageBoundary } from "./i18n/LanguageBoundary";
import "./i18n";
import "./index.css";

useAuth.getState().hydrate();
// F-04：多分頁共享 storage；讓其他分頁的登入／登出／refresh 即時反映到本頁記憶體。
registerAuthStorageSync();

// queryClient 的設定在 `lib/query-client`：auth store 的登出流程需要清除快取，
// 從 bootstrap 檔匯入會形成 main → App → auth → main 的循環依賴。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="system" storageKey={THEME_STORAGE_KEY}>
      <BrowserRouter>
        <LanguageBoundary>
          <App />
        </LanguageBoundary>
        <Toaster position="top-center" />
      </BrowserRouter>
    </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
);


