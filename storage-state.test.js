const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasReusableTradingViewSession,
  parseStorageState,
  seedCdpContextFromStorageState,
} = require("./storage-state");

test("parseStorageState accepts an object and rejects non-object JSON", () => {
  assert.deepEqual(parseStorageState('{"cookies":[],"origins":[]}'), {
    cookies: [],
    origins: [],
  });
  assert.throws(() => parseStorageState("null"), /must contain a JSON object/);
});

test("hasReusableTradingViewSession requires both live TradingView cookies", () => {
  const now = 2_000;
  assert.equal(
    hasReusableTradingViewSession([
      { name: "sessionid", expires: now + 100 },
      { name: "sessionid_sign", expires: now + 100 },
    ], now),
    true,
  );
  assert.equal(
    hasReusableTradingViewSession([
      { name: "sessionid", expires: now - 1 },
      { name: "sessionid_sign", expires: now + 100 },
    ], now),
    false,
  );
});

test("seedCdpContextFromStorageState preserves a live dedicated-profile session", async () => {
  let addedCookies = false;
  let addedInitScript = false;
  const context = {
    cookies: async () => [
      { name: "sessionid", expires: -1 },
      { name: "sessionid_sign", expires: -1 },
    ],
    addCookies: async () => { addedCookies = true; },
  };
  const page = { addInitScript: async () => { addedInitScript = true; } };

  const result = await seedCdpContextFromStorageState(context, page, {
    cookies: [{ name: "sessionid", value: "replacement" }],
    origins: [],
  });

  assert.deepEqual(result, { seeded: false, reason: "existing-session" });
  assert.equal(addedCookies, false);
  assert.equal(addedInitScript, false);
});

test("seedCdpContextFromStorageState seeds cookies and origin storage when missing", async () => {
  let addedCookies;
  let initScriptArg;
  const context = {
    cookies: async () => [],
    addCookies: async (cookies) => { addedCookies = cookies; },
  };
  const page = {
    addInitScript: async (_script, arg) => { initScriptArg = arg; },
  };
  const state = {
    cookies: [{ name: "sessionid", value: "restored" }],
    origins: [{
      origin: "https://www.tradingview.com",
      localStorage: [{ name: "theme", value: "dark" }],
    }],
  };

  const result = await seedCdpContextFromStorageState(context, page, state);

  assert.deepEqual(addedCookies, state.cookies);
  assert.deepEqual(initScriptArg, {
    "https://www.tradingview.com": state.origins[0].localStorage,
  });
  assert.deepEqual(result, { seeded: true, cookieCount: 1, originCount: 1 });
});
