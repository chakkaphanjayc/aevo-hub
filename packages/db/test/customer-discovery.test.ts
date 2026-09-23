import { describe, expect, it } from "bun:test";
import { isPublicDiscoveryBoundsAllowed, parsePublicDiscoveryBounds } from "../src/customer-discovery";

describe("parsePublicDiscoveryBounds", () => {
  it("accepts a valid west,south,east,north viewport", () => {
    expect(parsePublicDiscoveryBounds("100.48,13.70,100.56,13.79")).toEqual({
      west: 100.48,
      south: 13.7,
      east: 100.56,
      north: 13.79
    });
  });

  it("rejects malformed, out-of-range, and inverted viewports", () => {
    expect(parsePublicDiscoveryBounds("100.48,13.70,100.56")).toBeNull();
    expect(parsePublicDiscoveryBounds("100.48,nope,100.56,13.79")).toBeNull();
    expect(parsePublicDiscoveryBounds("181,13.70,100.56,13.79")).toBeNull();
    expect(parsePublicDiscoveryBounds("100.56,13.70,100.48,13.79")).toBeNull();
    expect(parsePublicDiscoveryBounds("100.48,13.79,100.56,13.70")).toBeNull();
  });
});

describe("isPublicDiscoveryBoundsAllowed", () => {
  it("allows viewport-sized queries and rejects world-scale scans", () => {
    const cityBounds = { west: 100.48, south: 13.7, east: 100.56, north: 13.79 };
    expect(isPublicDiscoveryBoundsAllowed(cityBounds, 14)).toBe(true);
    expect(isPublicDiscoveryBoundsAllowed({ west: 0, south: 0, east: 20, north: 20 }, 14)).toBe(false);
    expect(isPublicDiscoveryBoundsAllowed({ west: 0, south: 0, east: 20, north: 20 }, 4)).toBe(true);
  });
});
