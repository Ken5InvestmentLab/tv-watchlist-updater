const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPayload,
  sendNotifications,
} = require("./scripts/notify-discord");

test("success payload preserves its Japanese text and emoji", () => {
  const payload = buildPayload("success");

  assert.equal(payload.content, "🟢 **[System] Browser Automation Success**");
  assert.match(payload.embeds[0].description, /ウォッチリスト/);
  assert.equal(payload.embeds[0].color, 65280);
});

test("failure payload contains the supplied Actions run URL", () => {
  const runUrl = "https://github.com/example/repo/actions/runs/123";
  const payload = buildPayload("failure", runUrl);

  assert.equal(payload.embeds[0].url, runUrl);
  assert.equal(payload.embeds[0].color, 16711680);
});

test("notification body is UTF-8 JSON and webhook values are not logged", async () => {
  const requests = [];
  const messages = [];
  const webhookUrl = "https://discord.example.test/secret-token";

  const result = await sendNotifications({
    mode: "success",
    webhooks: [{ name: "DISCORD_WEBHOOK_1", url: webhookUrl }],
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204 };
    },
    logger: {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });

  assert.deepEqual(result, { attempted: 1, sent: 1 });
  assert.equal(requests[0].options.headers["content-type"], "application/json; charset=utf-8");
  assert.match(requests[0].options.body, /ウォッチリスト/);
  assert.ok(messages.every((message) => !message.includes(webhookUrl)));
});
