import { test } from "node:test";
import assert from "node:assert/strict";
import { CITY_COORDS, nearestCityKey } from "./ejar.city-coords";
import { EJAR_UNIT_TYPE, mapEjarValue } from "./ejar.import";

test("nearestCityKey: Ejar's coordinates for عمارة الشعلة (20407452240) → Dammam", () => {
  assert.equal(nearestCityKey(26.38987395, 50.062858), "dammam");
});

test("nearestCityKey: well-known spots", () => {
  assert.equal(nearestCityKey(24.6877, 46.7219), "riyadh");
  assert.equal(nearestCityKey(21.5433, 39.1728), "jeddah");
  assert.equal(nearestCityKey(26.2794, 50.2083), "al_khobar");
  assert.equal(nearestCityKey(24.15, 47.3), "al_kharj");
});

test("nearestCityKey: no coordinates, 0/0 or far from every city → null", () => {
  assert.equal(nearestCityKey(null, null), null);
  assert.equal(nearestCityKey(0, 0), null);
  assert.equal(nearestCityKey(22.0, 49.5), null); // Empty Quarter
});

test("CITY_COORDS: every point is inside Saudi Arabia", () => {
  for (const [k, [lat, lng]] of Object.entries(CITY_COORDS)) {
    assert.ok(lat > 16 && lat < 32.2 && lng > 34.5 && lng < 55.7, k);
  }
});

test("unit type: Ejar trade_exhibition → showroom (معرض)", () => {
  assert.equal(mapEjarValue(EJAR_UNIT_TYPE, "trade_exhibition"), "showroom");
});
