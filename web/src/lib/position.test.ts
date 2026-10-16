import { describe, expect, it } from "vitest";
import { after, between } from "./position";

describe("position", () => {
  it("between 回傳嚴格介於兩值之間", () => {
    const p = between("a", "c");
    expect(p > "a").toBe(true);
    expect(p < "c").toBe(true);
  });
  it("相鄰值仍可插入", () => {
    const p = between("a", "b");
    expect(p > "a").toBe(true);
    expect(p < "b").toBe(true);
  });
  it("after 回傳大於末值", () => {
    expect(after("z") > "z").toBe(true);
  });
  it("null 視為空端", () => {
    expect(between(null, "a") < "a").toBe(true);
    expect(after(null) > "").toBe(true);
  });
});
