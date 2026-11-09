import { QueryClient } from "@tanstack/react-query";
import axios from "axios";

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
