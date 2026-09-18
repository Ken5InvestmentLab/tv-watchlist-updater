"use strict";

const VALID_MODES = new Set(["success", "failure"]);

function buildPayload(mode, runUrl = "") {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unsupported notification mode: ${mode}`);
  }

  if (mode === "success") {
    return {
      username: "System Log",
      content: "🟢 **[System] Browser Automation Success**",
      embeds: [
        {
          title: "Update Completed",
          description:
            "TradingViewのウォッチリストとアラートの更新がすべて完了しました！",
          color: 65280,
        },
      ],
    };
  }

  return {
    username: "System Log",
    content: "🔴 **[System] Browser Automation Error**",
    embeds: [
      {
        title: "Playwright Error Log",
        url: runUrl,
        description:
          "TradingViewの操作中にエラーが発生しました。UI変更の可能性があります。",
        color: 16711680,
      },
    ],
  };
}

async function sendNotifications({
  mode,
  runUrl = "",
  webhooks,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This notification helper requires Node.js 18 or newer.");
  }

  const payload = buildPayload(mode, runUrl);
  let attempted = 0;
  let sent = 0;

  for (const webhook of webhooks) {
    if (!webhook.url || !webhook.url.trim()) {
      logger.warn(`${webhook.name} is empty. Skip.`);
      continue;
    }

    attempted += 1;
    try {
      const response = await fetchImpl(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      sent += 1;
      logger.log(`Discord notification sent: ${webhook.name}`);
    } catch (error) {
      logger.warn(
        `Failed to send Discord notification: ${webhook.name} (${error.message})`,
      );
    }
  }

  return { attempted, sent };
}

async function main() {
  const mode = process.argv[2];
  await sendNotifications({
    mode,
    runUrl: process.env.GITHUB_RUN_URL || "",
    webhooks: [
      { name: "DISCORD_WEBHOOK_1", url: process.env.DISCORD_WEBHOOK_1 || "" },
      { name: "DISCORD_WEBHOOK_2", url: process.env.DISCORD_WEBHOOK_2 || "" },
    ],
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildPayload, sendNotifications };
