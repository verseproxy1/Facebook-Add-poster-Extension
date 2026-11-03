// Popup UI Controller for Facebook Auto Poster (Glass + Group Library)
// v1.4 - import errors are shown, status messages are not overwritten by polling
const $ = (id) => document.getElementById(id);

// A short-lived message that the 1.5s status poll must not overwrite
let holdStatusUntil = 0;
function flashStatus(text, cls, ms = 6000) {
  $("queueStatus").textContent = text;
  $("queueStatus").className = cls || "";
  holdStatusUntil = Date.now() + ms;
}

// Safe wrapper: never throws, always returns an object
async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res || { error: "No response from background worker (try reloading the extension)." };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ----------------- TAB SWITCHING -----------------
$("tabAuto").addEventListener("click", () => switchTab("auto"));
$("tabManual").addEventListener("click", () => switchTab("manual"));

function switchTab(tab) {
  if (tab === "auto") {
    $("tabAuto").classList.add("active");
    $("tabManual").classList.remove("active");
    $("viewAuto").classList.remove("hidden");
    $("viewManual").classList.add("hidden");
  } else {
    $("tabManual").classList.add("active");
    $("tabAuto").classList.remove("active");
    $("viewManual").classList.remove("hidden");
    $("viewAuto").classList.add("hidden");
  }
}

// ----------------- GROUP LIBRARY -----------------
let groupLibrary = [];
let selectedGroupIds = [];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderGroupLibrary() {
  const container = $("groupLibraryList");
  const countEl = $("groupCount");

  countEl.textContent = `${groupLibrary.length} group${groupLibrary.length === 1 ? "" : "s"}`;

  if (!groupLibrary.length) {
    container.innerHTML = `<div class="empty-library">No groups yet.<br><span style="font-size:10px;opacity:0.8">Open any Facebook group and click the floating <b>+ Add Group</b> button</span></div>`;
    return;
  }

  container.innerHTML = groupLibrary
    .map((g) => {
      const checked = selectedGroupIds.includes(g.id) ? "checked" : "";
      const shortId = g.id.length > 12 ? g.id.slice(0, 10) + "…" : g.id;
      const safeId = escapeHtml(g.id);
      return `
      <div class="group-item" data-id="${safeId}">
        <input type="checkbox" class="g-check" data-id="${safeId}" ${checked}>
        <div class="g-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>
        <div class="g-id" title="${safeId}">${escapeHtml(shortId)}</div>
        <button type="button" class="g-remove" data-id="${safeId}" title="Remove">×</button>
      </div>`;
    })
    .join("");

  container.querySelectorAll(".g-check").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        if (!selectedGroupIds.includes(id)) selectedGroupIds.push(id);
      } else {
        selectedGroupIds = selectedGroupIds.filter((x) => x !== id);
      }
      await send({ action: "SET_SELECTED_GROUPS", ids: selectedGroupIds });
    });
  });

  container.querySelectorAll(".g-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await send({ action: "REMOVE_GROUP", id });
      groupLibrary = groupLibrary.filter((g) => g.id !== id);
      selectedGroupIds = selectedGroupIds.filter((x) => x !== id);
      renderGroupLibrary();
    });
  });
}

$("btnSelectAll").addEventListener("click", async () => {
  selectedGroupIds = groupLibrary.map((g) => g.id);
  await send({ action: "SET_SELECTED_GROUPS", ids: selectedGroupIds });
  renderGroupLibrary();
});

$("btnDeselectAll").addEventListener("click", async () => {
  selectedGroupIds = [];
  await send({ action: "SET_SELECTED_GROUPS", ids: [] });
  renderGroupLibrary();
});

$("btnImportToggle").addEventListener("click", () => {
  $("importBox").classList.toggle("hidden");
});

$("btnImport").addEventListener("click", async () => {
  const text = $("groupList").value.trim();
  if (!text) {
    flashStatus("Paste at least one group URL or ID first.", "error");
    return;
  }

  $("btnImport").disabled = true;
  const res = await send({ action: "IMPORT_GROUPS_TEXT", text });
  $("btnImport").disabled = false;

  if (res?.ok) {
    $("groupList").value = "";
    $("importBox").classList.add("hidden");
    await loadLibrary();

    let msg = `Imported ${res.added} new group(s). Total: ${res.total}.`;
    if (res.duplicates) msg += ` ${res.duplicates} already in library.`;
    if (res.skipped?.length) {
      msg += `\nCould not read ${res.skipped.length} line(s): ${res.skipped.slice(0, 3).join(" | ")}`;
    }
    flashStatus(msg, res.added > 0 ? "done" : "error", 9000);
  } else {
    flashStatus("Import failed: " + (res?.error || "unknown error"), "error", 9000);
  }
});

async function loadLibrary() {
  const res = await send({ action: "GET_STATE" });
  groupLibrary = res?.groupLibrary || [];
  selectedGroupIds = res?.selectedGroupIds || [];
  renderGroupLibrary();
}

// ----------------- AUTO QUEUE CONTROLLER -----------------
function updateCharCount() {
  const len = $("postText").value.length;
  $("charCount").textContent = `${len} char${len === 1 ? "" : "s"}`;
}

async function loadAutoSettings() {
  const saved = await chrome.storage.local.get([
    "post",
    "delayBetweenPosts",
    "cronConfig"
  ]);

  if (saved.post) {
    $("postText").value = saved.post;
    $("manualPost").value = saved.post;
  }
  if (saved.delayBetweenPosts) {
    $("postDelay").value = saved.delayBetweenPosts;
  }
  if (saved.cronConfig?.enabled && saved.cronConfig?.intervalMinutes) {
    $("cronInterval").value = String(saved.cronConfig.intervalMinutes);
    $("cronBadge").classList.remove("hidden");
    $("cronBadge").textContent = `CRON: Every ${saved.cronConfig.intervalMinutes}m`;
  }

  updateCharCount();
  await loadLibrary();
  pollQueueState();
}

async function saveAutoSettings() {
  await chrome.storage.local.set({
    post: $("postText").value,
    // 20s minimum between groups
    delayBetweenPosts: Math.max(20, Number($("postDelay").value) || 20)
  });
}

$("postText").addEventListener("input", () => {
  updateCharCount();
  saveAutoSettings();
});
$("postDelay").addEventListener("input", saveAutoSettings);

$("cronInterval").addEventListener("change", async () => {
  const minutes = Number($("cronInterval").value);
  if (minutes > 0) {
    await send({ action: "SET_CRON_SCHEDULE", intervalMinutes: minutes });
    $("cronBadge").classList.remove("hidden");
    $("cronBadge").textContent = `CRON: Every ${minutes}m`;
  } else {
    await send({ action: "CLEAR_CRON_SCHEDULE" });
    $("cronBadge").classList.add("hidden");
  }
  pollQueueState();
});

$("btnStartQueue").addEventListener("click", async () => {
  const text = $("postText").value.trim();

  if (!text) {
    flashStatus("Please enter post content first.", "error");
    return;
  }
  if (!selectedGroupIds.length) {
    flashStatus("Please select at least one group from the library.", "error");
    return;
  }

  await saveAutoSettings();

  const minutes = Number($("cronInterval").value);
  if (minutes > 0) {
    await send({ action: "SET_CRON_SCHEDULE", intervalMinutes: minutes });
  }

  const res = await send({ action: "START_AUTO_QUEUE" });
  if (res?.error || res?.ok === false) {
    flashStatus(res.error || res.message || "Could not start queue.", "error");
    return;
  }

  holdStatusUntil = 0;
  $("queueStatus").textContent = "Starting queue execution in background...";
  $("queueStatus").className = "running";
  $("btnStartQueue").classList.add("hidden");
  $("btnStopQueue").classList.remove("hidden");
  pollQueueState();
});

$("btnStopQueue").addEventListener("click", async () => {
  await send({ action: "STOP_AUTO_QUEUE" });
  holdStatusUntil = 0;
  $("queueStatus").textContent = "Stopping queue...";
  $("queueStatus").className = "";
  $("btnStartQueue").classList.remove("hidden");
  $("btnStopQueue").classList.add("hidden");
  pollQueueState();
});

async function pollQueueState() {
  try {
    const res = await send({ action: "GET_STATE" });
    if (!res || res.error) return;

    if (res.groupLibrary) {
      groupLibrary = res.groupLibrary;
      selectedGroupIds = res.selectedGroupIds || [];
      renderGroupLibrary();
    }

    const { queueState, cronConfig } = res;
    const isRunning = Boolean(queueState?.isRunning);

    $("btnStartQueue").classList.toggle("hidden", isRunning);
    $("btnStopQueue").classList.toggle("hidden", !isRunning);

    // Don't clobber a fresh import/validation message
    if (queueState?.statusText && Date.now() > holdStatusUntil) {
      $("queueStatus").textContent = queueState.statusText;
      const txt = queueState.statusText.toLowerCase();
      if (isRunning) {
        $("queueStatus").className = "running";
      } else if (txt.includes("finished") || txt.includes("complete") || txt.includes("done") || txt.includes("success")) {
        $("queueStatus").className = "done";
      } else if (txt.includes("error") || txt.includes("fail") || txt.includes("please") || txt.includes("stopped")) {
        $("queueStatus").className = "error";
      } else {
        $("queueStatus").className = "";
      }
    }

    if (cronConfig?.enabled) {
      $("cronBadge").classList.remove("hidden");
      $("cronBadge").textContent = `CRON: Every ${cronConfig.intervalMinutes}m`;
      $("cronInterval").value = String(cronConfig.intervalMinutes);
    } else {
      $("cronBadge").classList.add("hidden");
    }

    renderLogs(queueState?.logs || []);
  } catch (_) {}
}

function renderLogs(logs) {
  const container = $("logsContainer");
  if (!logs || !logs.length) {
    container.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:10px;">No posts executed yet.</div>';
    return;
  }

  container.innerHTML = logs
    .map(
      (l) => `
    <div class="log-item ${l.status}" style="flex-direction:column;align-items:flex-start;gap:2px;">
      <div style="display:flex;justify-content:space-between;width:100%;">
        <span><b>${escapeHtml(l.timestamp)}</b>: ${escapeHtml(l.groupTitle || l.group || "")}</span>
        <b style="color:${l.status === "success" ? "var(--success)" : "var(--danger)"};">${
          l.status === "success" ? "✓ Done" : "✗ Error"
        }</b>
      </div>
      <div style="font-size:10px;opacity:0.85;word-break:break-word;">${escapeHtml(
        l.message || (l.status === "success" ? "Published" : "Failed")
      )}</div>
    </div>`
    )
    .join("");
}

const pollInterval = setInterval(pollQueueState, 1500);
window.addEventListener("unload", () => clearInterval(pollInterval));

// ----------------- MANUAL SINGLE TAB HELPER -----------------
async function getActiveFbTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  if (!/^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(tab.url || "")) {
    throw new Error("Active tab is not Facebook. Switch to a Facebook tab first.");
  }
  return tab;
}

async function sendManual(action, busyMsg) {
  const statusEl = $("manualStatus");
  statusEl.textContent = busyMsg;
  try {
    const tab = await getActiveFbTab();
    const msg = {
      action,
      expectedGroup: $("manualGroup").value.trim(),
      postText: $("manualPost").value
    };

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, msg);
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      result = await chrome.tabs.sendMessage(tab.id, msg);
    }

    statusEl.textContent = result?.message || JSON.stringify(result);
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
  }
}

$("manualInspect").addEventListener("click", () => sendManual("INSPECT", "Inspecting page..."));
$("manualFill").addEventListener("click", () => sendManual("FILL", "Opening composer and filling text..."));
$("manualPublish").addEventListener("click", () => {
  if (confirm("Publish post to current Facebook group?")) {
    sendManual("PUBLISH", "Publishing post...");
  }
});

// Initialize
loadAutoSettings();