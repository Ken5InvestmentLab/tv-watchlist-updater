function validateAlertWebhookUrl(value) {
  const raw = String(value || "").trim();
  let url;
  try { url = new URL(raw); } catch { /* Fail before changing any live alerts. */ }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443")) {
    throw new Error("TRADINGVIEW_ALERT_WEBHOOK_URL must be a valid HTTPS webhook URL");
  }
  return raw;
}

async function configureAlertWebhook(page, webhookUrl) {
  const expected = validateAlertWebhookUrl(webhookUrl);
  const notifications = page.locator('[data-qa-id="alert-notifications-button"]');
  const checkbox = page.getByRole("checkbox", { name: "Webhook URL", exact: true });
  const input = page.getByRole("textbox", { name: "https://example.com/alert-hook", exact: true });
  const apply = page.getByRole("button", { name: /^(Apply|適用)$/ });

  await notifications.click({ timeout: 10000 });
  await checkbox.setChecked(true, { timeout: 10000 });
  await input.fill(expected, { timeout: 10000 });
  await assertWebhook();
  await apply.click({ timeout: 10000 });
  await notifications.waitFor({ state: "visible", timeout: 10000 });

  // Reopen the notification subform to detect a dropped/unsaved URL before Create.
  await notifications.click({ timeout: 10000 });
  await assertWebhook();
  await apply.click({ timeout: 10000 });
  await notifications.waitFor({ state: "visible", timeout: 10000 });
  if (!/Webhook/i.test(await notifications.innerText())) {
    throw new Error("Alert notification summary does not include Webhook; refusing to create alert");
  }
  console.log("[alert] Webhook enabled and URL verified after applying notifications");

  async function assertWebhook() {
    if (!(await checkbox.isChecked()) || !(await input.isEnabled()) ||
        (await input.inputValue()).trim() !== expected) {
      throw new Error("Alert Webhook settings were not retained; refusing to create alert");
    }
  }
}

module.exports = { validateAlertWebhookUrl, configureAlertWebhook };
