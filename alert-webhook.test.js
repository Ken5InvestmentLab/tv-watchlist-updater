const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAlertWebhookUrl, configureAlertWebhook } = require("./alert-webhook");

test("missing or invalid webhook configuration is rejected without revealing its value", () => {
  for (const value of ["", " ", "not-a-url", "http://example.com/hook", "https://u:secret@example.com/hook", "https://example.com:8443/hook", "https://example.com/hook#secret"]) {
    assert.throws(() => validateAlertWebhookUrl(value), error => {
      assert.match(error.message, /valid HTTPS/);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.equal(validateAlertWebhookUrl(" https://example.com/alert-hook?key=x "), "https://example.com/alert-hook?key=x");
});

// Model the two notification screens and persistence boundary. Applying may
// silently drop fields, as the upstream UI/defaults can change independently.
function notificationForm({ dropUrl = false, dropCheckbox = false } = {}) {
  let open = false;
  let draft = {};
  let saved = { checked: false, url: "" };
  let applications = 0;
  const notifications = {
    async click() { assert.equal(open, false); open = true; draft = { ...saved }; },
    async waitFor() { assert.equal(open, false); },
    async innerText() { return saved.checked ? "Webhook" : "None"; },
  };
  const checkbox = {
    async setChecked(value) { assert.ok(open); draft.checked = value; },
    async isChecked() { assert.ok(open); return draft.checked; },
  };
  const input = {
    async fill(value) { assert.ok(open && draft.checked); draft.url = value; },
    async isEnabled() { return open && draft.checked; },
    async inputValue() { assert.ok(open); return draft.url; },
  };
  const apply = {
    async click() {
      assert.ok(open);
      saved = { checked: dropCheckbox ? false : draft.checked, url: dropUrl ? "" : draft.url };
      applications++;
      open = false;
    },
  };
  return {
    page: {
      locator(selector) { assert.match(selector, /alert-notifications-button/); return notifications; },
      getByRole(role) { return { checkbox, textbox: input, button: apply }[role]; },
    },
    saved: () => ({ ...saved, applications }),
  };
}

test("an alert starting at Notifications None receives an explicit saved webhook", async () => {
  const form = notificationForm();
  await configureAlertWebhook(form.page, "https://example.com/alert-hook");
  assert.deepEqual(form.saved(), { checked: true, url: "https://example.com/alert-hook", applications: 2 });
});

test("a URL silently discarded by Apply fails the pre-create check", async () => {
  const form = notificationForm({ dropUrl: true });
  await assert.rejects(configureAlertWebhook(form.page, "https://example.com/alert-hook"), /not retained/);
});

test("a checkbox silently disabled by Apply fails the pre-create check", async () => {
  const form = notificationForm({ dropCheckbox: true });
  await assert.rejects(configureAlertWebhook(form.page, "https://example.com/alert-hook"), /not retained/);
});
