function countAlertText(alerts, targetText) {
  return alerts.filter((text) => text === targetText).length;
}

function hasAlertDeletionProgress(beforeCount, afterCount) {
  return Number.isFinite(beforeCount) && Number.isFinite(afterCount) && afterCount < beforeCount;
}

function isExcludedAlertText(text, excludedTexts = []) {
  return excludedTexts.some((excluded) =>
    text === excluded || text.startsWith(`${excluded},`) || text.startsWith(`${excluded} `)
  );
}

module.exports = {
  countAlertText,
  hasAlertDeletionProgress,
  isExcludedAlertText,
};
