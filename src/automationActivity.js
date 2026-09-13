const BOT_TABS = new Set(['bot1', 'bot2']);

function createAutomationActivity(expectedSenderId) {
  const activeTabs = new Set();

  function update(senderId, tabId, active) {
    if (senderId !== expectedSenderId) return false;
    if (!BOT_TABS.has(tabId)) return false;
    if (typeof active !== 'boolean') return false;
    if (active) activeTabs.add(tabId);
    else activeTabs.delete(tabId);
    return true;
  }

  function isActive() {
    return activeTabs.size > 0;
  }

  function reset() {
    activeTabs.clear();
    return false;
  }

  return { update, isActive, reset };
}

module.exports = { createAutomationActivity };
