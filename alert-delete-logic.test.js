const test = require("node:test");
const assert = require("node:assert/strict");
const { countAlertText, hasAlertDeletionProgress, isExcludedAlertText } = require("./alert-delete-logic");

test("同名アラートが2件ある場合は1件減少を削除成功と判定する", () => {
  const target = "wl1_20260910_0941, 4h";
  const before = [target, target];
  const after = [target];

  assert.equal(countAlertText(before, target), 2);
  assert.equal(countAlertText(after, target), 1);
  assert.equal(hasAlertDeletionProgress(2, 1), true);
});

test("同名アラートが残っていても件数減少があれば成功と判定する", () => {
  assert.equal(hasAlertDeletionProgress(1, 0), true);
  assert.equal(hasAlertDeletionProgress(2, 2), false);
  assert.equal(hasAlertDeletionProgress(2, 3), false);
});

test("別tickerの残存は対象tickerの削除件数判定に影響しない", () => {
  const target = "wl1_20260910_0941, 4h";
  const remaining = ["wl2_20260910_0941, 4h"];

  assert.equal(countAlertText(remaining, target), 0);
  assert.equal(hasAlertDeletionProgress(1, 0), true);
});

test("作成直後のticker表示に時間足が付いていても保護対象から除外できる", () => {
  assert.equal(
    isExcludedAlertText("wl1_20260911_1030, 4h", ["wl1_20260911_1030"]),
    true
  );
  assert.equal(
    isExcludedAlertText("wl2_20260911_1030, 4h", ["wl1_20260911_1030"]),
    false
  );
});
