import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import axios from "axios";
import App from "./App";
import { ThemeProvider } from "./components/theme-provider";
import { useAuth } from "./stores/auth";
import { THEME_STORAGE_KEY } from "./lib/storage-keys";
// 必須在 render 之前：資源內嵌且 init 同步，首次 render 就是正確語系（無 FOUC），
// 並在同步階段一併設好 document.documentElement.lang。
import { LanguageBoundary } from "./i18n/LanguageBoundary";
import "./i18n";
import "./index.css";

useAuth.getState().hydrate();

// #15/#23：staleTime 30s（回訪不立即重取）；403 權限錯誤不重試（重試無意義且卡 7.8s），其餘最多 2 次
// 429（2026-09-24 追加）：**限流也不重試**。重試正好是限流器在叫呼叫端別做的事，而預設的
// 「最多 2 次」會把**一次**超限放大成**三個**請求——第 2、3 次照樣逾額，還繼續吃掉窗內的額度，
// 於是下一個正常的搜尋更慢被放行。這是**同一個碼，兩種行為**：403 是「再送也不會變」，
// 429 是「現在不行、等一下可以」——兩者都當場放棄，但只有後者會在下次使用者動作時自然重來。
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 403 || status === 429) return false;
        return failureCount < 2;
      },
    },
  },
});

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


