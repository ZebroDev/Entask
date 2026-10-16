import { describe, expect, it } from "vitest";
import {
  AUTH_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  MINDMAP_CASCADE_DRAG_KEY,
  MINDMAP_COLLAPSED_PREFIX,
  THEME_STORAGE_KEY,
} from "./storage-keys";

// 契約鎖（非 TDD 修復）：這五個字串不是內部識別碼，而是「使用者瀏覽器上既有的鍵」。
// 改動任何一個值都等於一次破壞性變更——所有人被登出一次、主題、心智圖偏好與語系重置。
// 把值釘在這裡，是為了讓下一個想改的人必須先面對這件事，而不是順手改掉常數。
describe("storage keys 的對外契約", () => {
  it("值與已上線的鍵一致", () => {
    expect(AUTH_STORAGE_KEY).toBe("entask-auth");
    expect(THEME_STORAGE_KEY).toBe("entask-ui-theme");
    expect(MINDMAP_COLLAPSED_PREFIX).toBe("entask-mindmap-collapsed-");
    expect(MINDMAP_CASCADE_DRAG_KEY).toBe("entask-mindmap-cascade-drag");
    expect(LOCALE_STORAGE_KEY).toBe("entask-locale");
  });
});
