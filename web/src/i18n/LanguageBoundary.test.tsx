import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LanguageBoundary } from "./LanguageBoundary";
import { PSEUDO_LOCALE } from "./locales";
import i18n, { setLocale } from "@/i18n";

let probeMounts = 0;

function Probe() {
  probeMounts += 1;
  return <div>probe</div>;
}

beforeEach(() => {
  probeMounts = 0;
});

describe("LanguageBoundary", () => {
  it("子樹正常渲染", () => {
    const { getByText } = render(
      <LanguageBoundary>
        <Probe />
      </LanguageBoundary>,
    );
    expect(getByText("probe")).toBeTruthy();
    expect(probeMounts).toBe(1);
  });

  // 這支是 P-B1 的核心風險：format.ts 不是 hook，它讀模組層的 i18n。
  // 只用 format.ts 而沒有用 useTranslation 的元件不會自動重繪，切換語系後
  // 畫面上會留著舊語系的日期。LanguageBoundary 以 key 強制整棵子樹重掛來根治。
  it("切換語系時子樹重新掛載（純格式化元件才不會留著舊語系）", async () => {
    render(
      <LanguageBoundary>
        <Probe />
      </LanguageBoundary>,
    );
    expect(probeMounts).toBe(1);

    await act(async () => {
      await setLocale(PSEUDO_LOCALE);
    });

    expect(probeMounts).toBeGreaterThan(1);
  });

  it("切回原語系也會重新掛載", async () => {
    render(
      <LanguageBoundary>
        <Probe />
      </LanguageBoundary>,
    );
    await act(async () => {
      await setLocale(PSEUDO_LOCALE);
    });
    const afterSwitch = probeMounts;

    await act(async () => {
      await setLocale(null);
    });

    expect(probeMounts).toBeGreaterThan(afterSwitch);
    expect(i18n.resolvedLanguage).toBe("zh-TW");
  });
});
