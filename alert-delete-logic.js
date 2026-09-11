function countAlertText(alerts, targetText) {
  return alerts.filter((text) => text === targetText).length;
}

function hasAlertDeletionProgress(beforeCount, afterCount) {
  return Number.isFinite(beforeCount) && Number.isFinite(afterCount) && afterCount < beforeCount;
}

module.exports = {
  countAlertText,
  hasAlertDeletionProgress,
};
