#!/usr/bin/env node
"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RETRY_COUNT = parseInt(process.env.RETRY_COUNT || "0", 10);
const LOGS_DIR = path.resolve(process.cwd(), "logs_dir");
const MAX_LOG_CHARS = 12000;
const MAX_SOURCE_CHARS = 30000;

// ──────────────────────────────────────────
// ログ読み込み
// ──────────────────────────────────────────
function readLogs() {
  if (!fs.existsSync(LOGS_DIR)) {
    console.log("logs_dir not found, proceeding without logs.");
    return "(ログなし)";
  }
  const files = fs
    .readdirSync(LOGS_DIR, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".txt"))
    .map((f) => path.join(f.path || f.parentPath || LOGS_DIR, f.name));

  let combined = "";
  for (const f of files) {
    try {
      combined += fs.readFileSync(f, "utf-8");
    } catch (_) {}
  }
  // 末尾のMAX_LOG_CHARS文字だけ使う（エラーは大抵末尾にある）
  return combined.length > MAX_LOG_CHARS
    ? combined.slice(-MAX_LOG_CHARS)
    : combined || "(ログ空)";
}

// ──────────────────────────────────────────
// ソースコード読み込み
// ──────────────────────────────────────────
function readSources() {
  const targets = ["update-watchlist.js", "save-storage-state.js"];
  let result = "";
  for (const t of targets) {
    const full = path.resolve(process.cwd(), t);
    if (fs.existsSync(full)) {
      const content = fs.readFileSync(full, "utf-8");
      result += `\n\n=== ${t} ===\n${content}`;
    }
  }
  return result.length > MAX_SOURCE_CHARS
    ? result.slice(0, MAX_SOURCE_CHARS) + "\n...(truncated)"
    : result;
}

// ──────────────────────────────────────────
// メイン
// ──────────────────────────────────────────
async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY が設定されていません。");
    process.exit(1);
  }

  console.log(`\n=== Claude Auto-Fix: 試行 ${RETRY_COUNT + 1}/5 ===\n`);

  const logs = readLogs();
  const sources = readSources();

  const prompt = `あなたはPlaywright自動化スクリプトの修正専門家です。
GitHub Actionsのワークフローが失敗しました。原因を分析してコードを修正してください。

## 失敗ログ（末尾抜粋）
\`\`\`
${logs}
\`\`\`

## ソースコード
${sources}

## 指示
1. ログからエラー原因を特定する
2. 修正が必要なファイルと内容を決定する
3. 以下のJSON形式のみで回答する（前後に余分なテキスト不要）

\`\`\`json
{
  "analysis": "エラー原因の簡潔な説明（日本語）",
  "fixable": true,
  "files": [
    {
      "path": "ファイル名.js",
      "content": "修正後のファイル全体の内容"
    }
  ]
}
\`\`\`

修正できない場合（ネットワークエラー、認証切れ、外部サービス側の問題など）は fixable: false として files: [] にする。
修正するのはJavaScriptソースファイルのみ。ワークフローYAMLは変更しない。`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log("Claude APIを呼び出し中...");
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = message.content[0].text;
  console.log("\n--- Claude の分析 ---");

  // JSONを抽出
  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/) ||
    responseText.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    console.error("Claude の応答からJSONを解析できませんでした:");
    console.error(responseText.slice(0, 500));
    process.exit(1);
  }

  let fix;
  try {
    fix = JSON.parse(jsonMatch[1]);
  } catch (e) {
    console.error("JSON解析エラー:", e.message);
    console.error(jsonMatch[1].slice(0, 500));
    process.exit(1);
  }

  console.log("原因:", fix.analysis);

  if (!fix.fixable || !fix.files || fix.files.length === 0) {
    console.log("\nコードで修正できる問題ではないと判断されました。");
    console.log("自動修正をスキップします。");
    // exit 0 でワークフロー自体は成功扱いにする（無限ループ防止）
    process.exit(0);
  }

  console.log(`\n修正ファイル数: ${fix.files.length}`);
  for (const f of fix.files) {
    const filePath = path.resolve(process.cwd(), f.path);
    console.log(`  → ${f.path} を書き込み中...`);
    fs.writeFileSync(filePath, f.content, "utf-8");
  }

  console.log("\n修正完了！");
}

main().catch((err) => {
  console.error("auto-fix.js でエラーが発生しました:", err);
  process.exit(1);
});
