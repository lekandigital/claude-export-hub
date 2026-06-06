const CHAT_UUID_PATTERN = /\/chat\/([0-9a-f-]{36})/i;
const PREFS_KEY = "exportPreferences";

const tabs = document.querySelectorAll(".tab");
const panels = {
  current: document.getElementById("panel-current"),
  pick: document.getElementById("panel-pick"),
  all: document.getElementById("panel-all"),
};
const includeTranscript = document.getElementById("include-transcript");
const includeArtifacts = document.getElementById("include-artifacts");
const includePasted = document.getElementById("include-pasted");
const includeHint = document.getElementById("include-hint");
const exportBtn = document.getElementById("export");
const cancelBtn = document.getElementById("cancel");
const progressEl = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const statusEl = document.getElementById("status");
const searchInput = document.getElementById("search");
const chatList = document.getElementById("chat-list");
const listLoading = document.getElementById("list-loading");
const listEmpty = document.getElementById("list-empty");
const listError = document.getElementById("list-error");
const selectionCount = document.getElementById("selection-count");
const selectVisibleBtn = document.getElementById("select-visible");
const clearSelectionBtn = document.getElementById("clear-selection");
const allCountEl = document.getElementById("all-count");
const confirmOverlay = document.getElementById("confirm-overlay");
const confirmMessage = document.getElementById("confirm-message");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

const includeCheckboxes = [includeTranscript, includeArtifacts, includePasted];

let activeTab = "current";
let conversations = [];
let selectedUuids = new Set();
let pollTimer = null;
let listLoaded = false;

function getExportIncludes() {
  return {
    transcript: includeTranscript.checked,
    artifacts: includeArtifacts.checked,
    pasted: includePasted.checked,
  };
}

function getCheckedLabels() {
  const labels = [];
  if (includeTranscript.checked) {
    labels.push("chat.md");
  }
  if (includeArtifacts.checked) {
    labels.push("artifacts/");
  }
  if (includePasted.checked) {
    labels.push("pasted/");
  }
  return labels;
}

function hasAnyIncludeChecked() {
  return includeCheckboxes.some((cb) => cb.checked);
}

function updateIncludeHint() {
  const labels = getCheckedLabels();
  if (!labels.length) {
    includeHint.textContent = "Select at least one content type.";
    includeHint.classList.add("error");
    return;
  }
  includeHint.classList.remove("error");
  includeHint.textContent = `Each chat folder: ${labels.join(" · ")}`;
}

function getPrefs() {
  return {
    includes: getExportIncludes(),
    activeTab,
  };
}

async function savePrefs() {
  await chrome.storage.local.set({ [PREFS_KEY]: getPrefs() });
}

async function loadPrefs() {
  const result = await chrome.storage.local.get([PREFS_KEY]);
  const prefs = result[PREFS_KEY];
  if (!prefs) {
    return;
  }
  if (prefs.includes) {
    includeTranscript.checked = prefs.includes.transcript !== false;
    includeArtifacts.checked = prefs.includes.artifacts !== false;
    includePasted.checked = prefs.includes.pasted !== false;
  }
  if (prefs.activeTab) {
    switchTab(prefs.activeTab, false);
  }
}

function switchTab(name, persist = true) {
  activeTab = name;
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  Object.entries(panels).forEach(([key, panel]) => {
    panel.classList.toggle("active", key === name);
  });

  if (name === "pick" && !listLoaded) {
    loadConversations();
  }
  if (name === "all" && conversations.length) {
    updateAllCount();
  }
  updateExportButton();
  if (persist) {
    savePrefs();
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

includeCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    updateIncludeHint();
    updateExportButton();
    savePrefs();
  });
});

function formatRelativeDate(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
}

function getFilteredConversations() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    return conversations;
  }
  return conversations.filter((c) =>
    (c.name || "").toLowerCase().includes(query),
  );
}

function renderChatList() {
  const filtered = getFilteredConversations();
  chatList.innerHTML = "";

  if (!filtered.length) {
    chatList.hidden = true;
    listEmpty.hidden = false;
    listEmpty.textContent = searchInput.value.trim()
      ? "No matching conversations."
      : "No conversations found.";
    updateSelectionCount();
    return;
  }

  listEmpty.hidden = true;
  chatList.hidden = false;

  for (const conv of filtered) {
    const li = document.createElement("li");
    li.className = "chat-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedUuids.has(conv.uuid);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedUuids.add(conv.uuid);
      } else {
        selectedUuids.delete(conv.uuid);
      }
      updateSelectionCount();
      updateExportButton();
    });

    const meta = document.createElement("div");
    meta.className = "chat-meta";

    const title = document.createElement("div");
    title.className = "chat-title";
    title.textContent = conv.name || "Untitled";
    title.title = conv.name || "Untitled";

    const date = document.createElement("div");
    date.className = "chat-date";
    date.textContent = formatRelativeDate(conv.updated_at);

    meta.appendChild(title);
    meta.appendChild(date);
    li.appendChild(checkbox);
    li.appendChild(meta);

    li.addEventListener("click", (event) => {
      if (event.target === checkbox) {
        return;
      }
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    chatList.appendChild(li);
  }

  updateSelectionCount();
}

function updateSelectionCount() {
  const filtered = getFilteredConversations();
  const visibleSelected = filtered.filter((c) =>
    selectedUuids.has(c.uuid),
  ).length;
  if (activeTab === "pick") {
    selectionCount.textContent = `${selectedUuids.size} selected (${visibleSelected} visible)`;
  }
}

function updateAllCount() {
  if (conversations.length) {
    allCountEl.textContent = `${conversations.length} conversations available.`;
  } else {
    allCountEl.textContent = "";
  }
}

async function loadConversations() {
  listLoading.hidden = false;
  listError.hidden = true;
  chatList.hidden = true;
  listEmpty.hidden = true;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const response = await chrome.runtime.sendMessage({
      action: "listConversations",
      tabId: tab?.id,
    });
    if (!response?.success) {
      throw new Error(response?.error || "Failed to load conversations.");
    }
    conversations = response.conversations || [];
    listLoaded = true;
    listLoading.hidden = true;
    renderChatList();
    updateAllCount();
  } catch (error) {
    listLoading.hidden = true;
    listError.hidden = false;
    listError.textContent = error.message;
  }
}

searchInput.addEventListener("input", renderChatList);

selectVisibleBtn.addEventListener("click", () => {
  for (const conv of getFilteredConversations()) {
    selectedUuids.add(conv.uuid);
  }
  renderChatList();
  updateExportButton();
});

clearSelectionBtn.addEventListener("click", () => {
  selectedUuids.clear();
  renderChatList();
  updateExportButton();
});

function getExportOptions() {
  return {
    exportIncludes: getExportIncludes(),
  };
}

function updateExportButton() {
  const noneChecked = !hasAnyIncludeChecked();

  if (activeTab === "pick") {
    exportBtn.textContent =
      selectedUuids.size > 0
        ? `Export ${selectedUuids.size} chat${selectedUuids.size === 1 ? "" : "s"}`
        : "Export selected";
    exportBtn.disabled = selectedUuids.size === 0 || noneChecked;
  } else if (activeTab === "all") {
    exportBtn.textContent = "Export all chats";
    exportBtn.disabled = noneChecked;
  } else {
    exportBtn.textContent = "Export this chat";
    exportBtn.disabled = noneChecked;
  }
}

function setUiRunning(running) {
  const noneChecked = !hasAnyIncludeChecked();
  exportBtn.disabled =
    running ||
    noneChecked ||
    (activeTab === "pick" && selectedUuids.size === 0);
  cancelBtn.hidden = !running;
  tabs.forEach((t) => {
    t.disabled = running;
  });
  includeCheckboxes.forEach((cb) => {
    cb.disabled = running;
  });
  searchInput.disabled = running;
}

function showProgress(job) {
  if (!job || job.status === "done" || job.status === "error") {
    progressEl.classList.remove("visible");
    return;
  }

  progressEl.classList.add("visible");
  const total = job.total || 1;
  const current = job.current || 0;
  const pct = job.phase === "listing" ? 5 : Math.round((current / total) * 100);
  progressFill.style.width = `${Math.min(pct, 100)}%`;

  const phaseLabels = {
    listing: "Preparing…",
    fetching: `Fetching chat ${current} of ${total}`,
    zipping: "Creating ZIP…",
    downloading: "Starting download…",
  };
  const phase = phaseLabels[job.phase] || "Working…";
  const name = job.currentChatName ? ` — ${job.currentChatName}` : "";
  progressText.textContent = `${phase}${name}`;
}

function showStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", isError);
}

function showExportResult(job, isError = false) {
  const summary = job.message || "";
  showStatus(summary.split("\n")[0], isError);
}

function getIncludeSummaryForConfirm() {
  const labels = getCheckedLabels();
  return labels.length ? labels.join(", ") : "nothing";
}

async function getActiveTabInfo() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const uuid = tab?.url?.match(CHAT_UUID_PATTERN)?.[1];
  return { tab, uuid };
}

async function startExport(scope, extra = {}) {
  if (!hasAnyIncludeChecked()) {
    showStatus("Select at least one content type.", true);
    return;
  }

  const options = getExportOptions();
  const { tab, uuid } = await getActiveTabInfo();

  setUiRunning(true);
  showStatus("");
  progressEl.classList.add("visible");
  progressFill.style.width = "2%";
  progressText.textContent = "Starting export…";

  const payload = {
    action: "startExportJob",
    scope,
    tabId: tab?.id,
    uuid: scope === "current" ? uuid : undefined,
    uuids: scope === "selected" ? [...selectedUuids] : undefined,
    ...options,
    ...extra,
  };

  if (scope === "current" && !uuid) {
    setUiRunning(false);
    showStatus("Open a Claude chat in the active tab.", true);
    progressEl.classList.remove("visible");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.success) {
      throw new Error(response?.error || "Export failed to start.");
    }
    startPolling();
  } catch (error) {
    setUiRunning(false);
    showStatus(error.message, true);
    progressEl.classList.remove("visible");
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollJobStatus, 500);
  pollJobStatus();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollJobStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getExportJobStatus",
    });
    const job = response?.job;
    if (!job) {
      return;
    }

    showProgress(job);

    if (job.status === "running" || job.status === "cancelling") {
      setUiRunning(true);
      return;
    }

    stopPolling();
    setUiRunning(false);
    progressEl.classList.remove("visible");

    if (job.status === "done") {
      showExportResult(job);
    } else if (job.status === "cancelled") {
      showExportResult(job);
    } else if (job.status === "error") {
      showExportResult(job, true);
    }
  } catch {
    // ignore transient errors while popup is open
  }
}

exportBtn.addEventListener("click", async () => {
  if (activeTab === "all") {
    if (!conversations.length && !listLoaded) {
      await loadConversations();
    }
    const count = conversations.length || "your";
    const includes = getIncludeSummaryForConfirm();
    confirmMessage.textContent = `Export all ${count} conversations? Each chat will be saved as its own folder including: ${includes}. This may take several minutes.`;
    confirmOverlay.classList.add("visible");
    return;
  }

  if (activeTab === "pick") {
    if (selectedUuids.size === 0) {
      return;
    }
    await startExport("selected");
    return;
  }

  await startExport("current");
});

confirmOk.addEventListener("click", async () => {
  confirmOverlay.classList.remove("visible");
  await startExport("all");
});

confirmCancel.addEventListener("click", () => {
  confirmOverlay.classList.remove("visible");
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "cancelExportJob" });
  showStatus("Cancelling…");
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "exportProgress" && request.job) {
    showProgress(request.job);
    if (
      request.job.status === "done" ||
      request.job.status === "error" ||
      request.job.status === "cancelled"
    ) {
      stopPolling();
      setUiRunning(false);
      progressEl.classList.remove("visible");
      showExportResult(
        request.job,
        request.job.status === "error",
      );
    } else {
      setUiRunning(true);
    }
  }
});

loadPrefs().then(async () => {
  updateIncludeHint();
  updateExportButton();
  const response = await chrome.runtime.sendMessage({
    action: "getExportJobStatus",
  });
  if (response?.job?.status === "running") {
    setUiRunning(true);
    startPolling();
  }
});
