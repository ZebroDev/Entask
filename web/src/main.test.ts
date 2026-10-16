import { AxiosError, type AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";

// main.tsx 為 bootstrap 檔：mock react-dom/client 避免測試環境實際掛載整棵 App
// （main.tsx 以 default import 引入 ReactDOM，mock 須提供 default export）
vi.mock("react-dom/client", () => ({
  default: { createRoot: vi.fn(() => ({ render: vi.fn() })) },
}));

import { queryClient } from "./main";

const forbiddenResponse = {
  status: 403,
  statusText: "Forbidden",
  data: null,
  headers: {},
  config: { headers: undefined },
} as unknown as AxiosResponse;

const tooManyResponse = {
  status: 429,
  statusText: "Too Many Requests",
  data: null,
  headers: {},
  config: { headers: undefined },
} as unknown as AxiosResponse;

describe("QueryClient 全域配置（#15/#23）", () => {
  it("queries staleTime 為 30 秒", () => {
    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(30_000);
  });

  it("retry：axios 403 不重試、其餘錯誤最多重試 2 次", () => {
    const retry = queryClient.getDefaultOptions().queries?.retry;
    expect(typeof retry).toBe("function");
    const retryFn = retry as (failureCount: number, error: Error) => boolean;
    const forbidden = new AxiosError(
      "Request failed with status code 403",
      undefined,
      undefined,
      undefined,
      forbiddenResponse,
    );
    expect(retryFn(0, forbidden)).toBe(false);
    expect(retryFn(2, forbidden)).toBe(false);
    const generic = new Error("network down");
    expect(retryFn(0, generic)).toBe(true);
    expect(retryFn(1, generic)).toBe(true);
    expect(retryFn(2, generic)).toBe(false);
  });

  // 429（2026-09-24）。守門員在這裡而不是在限流器那一側：限流器只管伺服器端讓不讓過，
  // 而**把一次超限放大成三個請求**的是這一支重試條件——少了這條斷言，「不加 429」與
  // 「加了 429」在測試上分不開，而前者的症狀是使用者的下一個搜尋更慢被放行（看不到紅燈）。
  it("retry：axios 429（限流）不重試——重試正是限流器在叫呼叫端別做的事", () => {
    const retry = queryClient.getDefaultOptions().queries?.retry;
    const retryFn = retry as (failureCount: number, error: Error) => boolean;
    const tooMany = new AxiosError(
      "Request failed with status code 429",
      undefined,
      undefined,
      undefined,
      tooManyResponse,
    );
    expect(retryFn(0, tooMany)).toBe(false);
    expect(retryFn(2, tooMany)).toBe(false);
  });
});
