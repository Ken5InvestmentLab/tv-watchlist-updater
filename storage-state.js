const TRADINGVIEW_ORIGIN = "https://www.tradingview.com";
const REQUIRED_SESSION_COOKIES = ["sessionid", "sessionid_sign"];

function parseStorageState(rawValue) {
  if (!rawValue) return null;

  const state = JSON.parse(rawValue);
  if (!state || typeof state !== "object") {
    throw new Error("TRADINGVIEW_STORAGE_STATE must contain a JSON object");
  }
  return state;
}

function isLiveCookie(cookie, nowSeconds) {
  if (!cookie) return false;
  const expires = Number(cookie.expires);
  return !Number.isFinite(expires) || expires <= 0 || expires > nowSeconds;
}

function hasReusableTradingViewSession(cookies, nowSeconds = Date.now() / 1000) {
  return REQUIRED_SESSION_COOKIES.every((name) =>
    cookies.some((cookie) => cookie.name === name && isLiveCookie(cookie, nowSeconds)),
  );
}

async function seedCdpContextFromStorageState(context, page, storageState) {
  if (!storageState) return { seeded: false, reason: "missing" };

  const currentCookies = await context.cookies(TRADINGVIEW_ORIGIN);
  if (hasReusableTradingViewSession(currentCookies)) {
    return { seeded: false, reason: "existing-session" };
  }

  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
  if (cookies.length > 0) await context.addCookies(cookies);

  const localStorageByOrigin = Object.fromEntries(
    (Array.isArray(storageState.origins) ? storageState.origins : [])
      .filter((entry) => entry?.origin && Array.isArray(entry.localStorage))
      .map((entry) => [entry.origin, entry.localStorage]),
  );

  if (Object.keys(localStorageByOrigin).length > 0) {
    await page.addInitScript((entriesByOrigin) => {
      for (const item of entriesByOrigin[location.origin] || []) {
        localStorage.setItem(item.name, item.value);
      }
    }, localStorageByOrigin);
  }

  return {
    seeded: true,
    cookieCount: cookies.length,
    originCount: Object.keys(localStorageByOrigin).length,
  };
}

module.exports = {
  hasReusableTradingViewSession,
  parseStorageState,
  seedCdpContextFromStorageState,
};
