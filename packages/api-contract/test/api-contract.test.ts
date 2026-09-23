import { describe, expect, test } from "bun:test";
import { isApplicationCode, isSafeReturnPath, safeReturnPath } from "../src";

describe("@aevocado/api-contract", () => {
  test("accepts only known application boundaries", () => {
    expect(isApplicationCode("HUB")).toBe(true);
    expect(isApplicationCode("hub")).toBe(false);
    expect(isApplicationCode("NOT_AN_APP")).toBe(false);
  });

  test("rejects open-redirect return paths", () => {
    expect(isSafeReturnPath("/workspace?storeId=store-1")).toBe(true);
    expect(isSafeReturnPath("https://evil.example/steal")).toBe(false);
    expect(isSafeReturnPath("//evil.example/steal")).toBe(false);
    expect(isSafeReturnPath("/%2f%2fevil.example")).toBe(false);
    expect(safeReturnPath("https://evil.example", "/login")).toBe("/login");
  });
});
