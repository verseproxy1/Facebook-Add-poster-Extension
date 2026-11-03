// Background Service Worker for Local Facebook UI Assistant
// Posts via the group's direct feed composer ("Write something...")

const ALARM_NAME = "FACEBOOK_POST_CRON";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Facebook UI Assistant background service worker ready.");
});

// Sleep helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Format input line into a proper Facebook group URL
function formatGroupUrl(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://www.facebook.com/groups/${trimmed.replace(/^\/+/, "")}/`;
}

// Dismiss "Leave site?" dialog and navigate robustly
async function navigateTab(tabId, url) {
  // Inject beforeunload remover BEFORE navigating so Facebook doesn't block navigation
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        // Remove all beforeunload listeners so "Leave site?" doesn't appear
        window.onbeforeunload = null;
        window.addEventListener("beforeunload", (e) => {
          e.stopImmediatePropagation();
          delete e.returnValue;
        }, true);
      }
    });
  } catch (_) {}

  await chrome.tabs.update(tabId, { url, active: true });

  for (let i = 0; i < 25; i++) {
    await delay(1000);
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") break;
    } catch (_) { break; }
  }
  // Wait for dynamic React/Relay client-side hydration
  await delay(4000);
}

// Helper: random delay between min and max seconds
function randomDelaySec(baseSec) {
  const base = Math.max(8, Number(baseSec) || 18);
  // ±35% randomness for more human-like timing
  const variance = Math.floor(base * 0.35);
  return base + Math.floor(Math.random() * (variance * 2 + 1)) - variance;
}

// Send a message to the group tab's content script; inject it only if the page never loaded it
async function sendToGroupTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    if (!/Receiving end does not exist/i.test(err.message || "")) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// Core Queue Execution (supports Group Library + fallback to old textarea)
async function runQueue() {
  const store = await chrome.storage.local.get([
    "queueState",
    "savedGroups",
    "groupLibrary",
    "selectedGroupIds",
    "post",
    "delayBetweenPosts"
  ]);

  let groups = [];

  // Prefer selected groups from the new library
  const library = Array.isArray(store.groupLibrary) ? store.groupLibrary : [];
  const selectedIds = Array.isArray(store.selectedGroupIds) ? store.selectedGroupIds : [];

  if (selectedIds.length && library.length) {
    groups = library
      .filter((g) => selectedIds.includes(g.id))
      .map((g) => g.url || formatGroupUrl(g.id))
      .filter(Boolean);
  }

  // Fallback to old textarea format if library selection is empty
  if (!groups.length && store.savedGroups) {
    groups = (store.savedGroups || "")
      .split("\n")
      .map(formatGroupUrl)
      .filter(Boolean);
  }

  // === STRONG DEDUPLICATION ===
  // Normalize every URL to a unique group key so the same group never runs twice
  function groupKey(url) {
    if (!url) return "";
    const m = String(url).match(/\/groups\/([^/?#]+)/i);
    return (m ? m[1] : url).toLowerCase().replace(/\/+$/, "");
  }

  const seen = new Set();
  const uniqueGroups = [];
  for (const g of groups) {
    const key = groupKey(g);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueGroups.push(g);
  }
  groups = uniqueGroups;

  const postText = (store.post || "").trim();
  const baseDelay = Math.max(8, Number(store.delayBetweenPosts) || 18);

  if (!groups.length || !postText) {
    await chrome.storage.local.set({
      queueState: {
        isRunning: false,
        statusText: "Stopped: Select at least one group and provide post text.",
        logs: store.queueState?.logs || []
      }
    });
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  let state = {
    isRunning: true,
    currentIndex: 0,
    total: groups.length,
    statusText: `Starting automated queue (0/${groups.length}) — ${groups.length} unique groups...`,
    logs: store.queueState?.logs || []
  };
  await chrome.storage.local.set({ queueState: state });

  // Locate or create a Facebook tab
  const allTabs = await chrome.tabs.query({});
  let tab = allTabs.find((t) => t.url && t.url.includes("facebook.com"));
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://www.facebook.com/", active: true });
    await delay(5000);
  }

  let successCount = 0;
  let failCount = 0;
  const postedKeysThisRun = new Set(); // never post same group twice in one run

  for (let i = 0; i < groups.length; i++) {
    const currentStore = await chrome.storage.local.get("queueState");
    if (!currentStore.queueState?.isRunning) {
      console.log("Queue stopped by user.");
      await chrome.action.setBadgeText({ text: "" });
      return;
    }

    const groupUrl = groups[i];
    const key = groupKey(groupUrl);

    // Skip if already posted in this run (extra safety)
    if (postedKeysThisRun.has(key)) {
      state.logs.unshift({
        timestamp: new Date().toLocaleTimeString(),
        group: groupUrl,
        status: "success",
        message: "Skipped — already posted in this run"
      });
      await chrome.storage.local.set({ queueState: state });
      continue;
    }

    state.currentIndex = i + 1;
    state.statusText = `[${i + 1}/${groups.length}] Opening group...`;
    await chrome.storage.local.set({ queueState: state });
    await chrome.action.setBadgeText({ text: `${i + 1}/${groups.length}` });
    await chrome.action.setBadgeBackgroundColor({ color: "#6c9bff" });

    const logEntry = {
      timestamp: new Date().toLocaleTimeString(),
      group: groupUrl,
      status: "pending",
      message: "Navigating..."
    };

    // NO automatic retry on success ambiguity — retry only once on clear navigation errors
    let posted = false;
    let lastError = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts && !posted; attempt++) {
      try {
        if (attempt > 1) {
          // Only retry if previous error looked like a navigation / load problem
          const errMsg = (lastError || "").toLowerCase();
          const isRetryable =
            errMsg.includes("navigat") ||
            errMsg.includes("timeout") ||
            errMsg.includes("not found") ||
            errMsg.includes("could not open") ||
            errMsg.includes("editor");
          if (!isRetryable) break; // do NOT retry if post may have already succeeded

          state.statusText = `[${i + 1}/${groups.length}] Retrying (attempt ${attempt})...`;
          await chrome.storage.local.set({ queueState: state });
          await delay(5000);
        }

        await navigateTab(tab.id, groupUrl);

        state.statusText = `[${i + 1}/${groups.length}] Writing post...`;
        await chrome.storage.local.set({ queueState: state });

        // Same composer code the manual helper uses (content.js), so there is only one writer to maintain
        const filled = await sendToGroupTab(tab.id, { action: "FILL", postText });
        if (!filled?.success) {
          throw new Error(filled?.error || "Could not fill post.");
        }

        state.statusText = `[${i + 1}/${groups.length}] Publishing...`;
        await chrome.storage.local.set({ queueState: state });

        const res = await sendToGroupTab(tab.id, { action: "PUBLISH", postText });
        if (!res?.success) {
          throw new Error(res?.error || "Could not publish post.");
        }

        logEntry.status = "success";
        logEntry.message = res.message || "Published";
        if (res.groupTitle) logEntry.groupTitle = res.groupTitle;
        posted = true;
        postedKeysThisRun.add(key);
        successCount++;

        // Kill beforeunload so next navigation is clean
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              window.onbeforeunload = null;
              window.addEventListener("beforeunload", (e) => {
                e.stopImmediatePropagation();
                delete e.returnValue;
              }, true);
            }
          });
        } catch (_) {}

      } catch (err) {
        lastError = err.message || "Failed to post";
        logEntry.status = "error";
        logEntry.message = lastError;

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () => {
              window.onbeforeunload = null;
              window.addEventListener("beforeunload", (e) => {
                e.stopImmediatePropagation();
                delete e.returnValue;
              }, true);
            }
          });
        } catch (_) {}
      }
    }

    if (!posted) failCount++;

    state.logs.unshift(logEntry);
    if (state.logs.length > 50) state.logs.pop();
    await chrome.storage.local.set({ queueState: state });

    // Human-like random delay between groups
    if (i < groups.length - 1) {
      const waitSec = randomDelaySec(baseDelay);
      for (let s = waitSec; s > 0; s--) {
        const check = await chrome.storage.local.get("queueState");
        if (!check.queueState?.isRunning) break;
        state.statusText = `[${i + 1}/${groups.length}] Done. Waiting ${s}s (human-like)...`;
        await chrome.storage.local.set({ queueState: state });
        await delay(1000);
      }
    }
  }

  state.isRunning = false;
  state.statusText = `Queue finished! ✓ ${successCount} success, ✗ ${failCount} failed out of ${groups.length}.`;
  await chrome.storage.local.set({ queueState: state });
  await chrome.action.setBadgeText({ text: "DONE" });
  await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  await delay(5000);
  await chrome.action.setBadgeText({ text: "" });
}

// Alarm Listener for Cron jobs
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log("Cron alarm fired. Executing Facebook post queue...");
    const { queueState } = await chrome.storage.local.get("queueState");
    if (queueState?.isRunning) {
      console.warn("Queue already in progress, skipping.");
      return;
    }
    await runQueue();
  }
});

// Runtime Message Handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === "START_AUTO_QUEUE") {
      runQueue();
      return { ok: true, message: "Queue started" };
    }

    if (msg.action === "STOP_AUTO_QUEUE") {
      const { queueState = {} } = await chrome.storage.local.get("queueState");
      queueState.isRunning = false;
      queueState.statusText = "Queue stopped by user.";
      await chrome.storage.local.set({ queueState });
      await chrome.action.setBadgeText({ text: "" });
      return { ok: true, message: "Queue stopped" };
    }

    if (msg.action === "SET_CRON_SCHEDULE") {
      const minutes = Math.max(1, Number(msg.intervalMinutes) || 10);
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: minutes,
        periodInMinutes: minutes
      });
      await chrome.storage.local.set({
        cronConfig: {
          enabled: true,
          intervalMinutes: minutes,
          nextRun: Date.now() + minutes * 6 * 10
        }
      });
      return { ok: true, message: `Scheduled every ${minutes} minutes.` };
    }

    if (msg.action === "CLEAR_CRON_SCHEDULE") {
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.storage.local.set({
        cronConfig: { enabled: false, intervalMinutes: 0 }
      });
      return { ok: true, message: "Schedule cancelled." };
    }

    if (msg.action === "GET_STATE") {
      const store = await chrome.storage.local.get([
        "queueState",
        "cronConfig",
        "groupLibrary",
        "selectedGroupIds"
      ]);
      const alarm = await chrome.alarms.get(ALARM_NAME);
      return {
        queueState: store.queueState || { isRunning: false, statusText: "Idle", logs: [] },
        cronConfig: store.cronConfig || { enabled: false },
        groupLibrary: store.groupLibrary || [],
        selectedGroupIds: store.selectedGroupIds || [],
        alarmScheduledTime: alarm ? alarm.scheduledTime : null
      };
    }

    // ---- Group Library ----
    if (msg.action === "ADD_GROUP") {
      const g = msg.group;
      if (!g || !g.id) return { ok: false, error: "Invalid group" };

      const id = String(g.id).trim();
      const idLower = id.toLowerCase();

      const store = await chrome.storage.local.get(["groupLibrary", "selectedGroupIds"]);
      let library = Array.isArray(store.groupLibrary) ? store.groupLibrary : [];
      let selected = Array.isArray(store.selectedGroupIds) ? store.selectedGroupIds : [];

      // Strong duplicate check (case-insensitive)
      const exists = library.some((x) => String(x.id).toLowerCase() === idLower);
      if (exists) {
        return { ok: true, already: true };
      }

      library.unshift({
        id,
        name: g.name || id,
        url: g.url || `https://www.facebook.com/groups/${id}`,
        addedAt: Date.now()
      });

      // Auto-select newly added group
      if (!selected.includes(id)) selected.push(id);

      await chrome.storage.local.set({ groupLibrary: library, selectedGroupIds: selected });
      return { ok: true, already: false, count: library.length };
    }

    if (msg.action === "REMOVE_GROUP") {
      const id = msg.id;
      const store = await chrome.storage.local.get(["groupLibrary", "selectedGroupIds"]);
      let library = (store.groupLibrary || []).filter((g) => g.id !== id);
      let selected = (store.selectedGroupIds || []).filter((x) => x !== id);
      await chrome.storage.local.set({ groupLibrary: library, selectedGroupIds: selected });
      return { ok: true, count: library.length };
    }

    if (msg.action === "SET_SELECTED_GROUPS") {
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      await chrome.storage.local.set({ selectedGroupIds: ids });
      return { ok: true };
    }

    if (msg.action === "IMPORT_GROUPS_TEXT") {
      // Parse pasted URLs / IDs into the library
      const lines = (msg.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const store = await chrome.storage.local.get(["groupLibrary", "selectedGroupIds"]);
      let library = Array.isArray(store.groupLibrary) ? store.groupLibrary : [];
      let selected = Array.isArray(store.selectedGroupIds) ? store.selectedGroupIds : [];
      let added = 0;

      for (const line of lines) {
        const url = formatGroupUrl(line);
        if (!url) continue;
        const match = url.match(/\/groups\/([^/?#]+)/i);
        const id = match ? match[1] : null;
        if (!id) continue;
        const idLower = id.toLowerCase();
        if (library.some((g) => String(g.id).toLowerCase() === idLower)) continue;

        library.unshift({
          id,
          name: id,
          url: `https://www.facebook.com/groups/${id}`,
          addedAt: Date.now()
        });
        if (!selected.includes(id)) selected.push(id);
        added++;
      }

      await chrome.storage.local.set({ groupLibrary: library, selectedGroupIds: selected });
      return { ok: true, added, total: library.length };
    }

    throw new Error("Unknown action: " + msg.action);
  })().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});