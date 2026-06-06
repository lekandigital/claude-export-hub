const LOG_PREFIX = "[Claude Artifact Downloader]";
const CHAT_UUID_PATTERN = /\/chat\/([0-9a-f-]{36})/i;
const CHAT_PAGE_PATTERN = /^https:\/\/claude\.ai\/chat\/[^/]+/i;

function extractChatUuid(url) {
  const match = url.match(CHAT_UUID_PATTERN);
  return match ? match[1] : null;
}

function isChatPage(url) {
  return CHAT_PAGE_PATTERN.test(url);
}

function createDownloadContainer() {
  const downloadContainer = document.createElement("div");
  downloadContainer.className =
    "claude-download-container flex items-center gap-2 shrink-0";
  downloadContainer.setAttribute("data-claude-downloader", "true");

  const downloadButton = createButton("Download artifacts");
  const optionsDropdown = createOptionsDropdown();

  downloadContainer.appendChild(optionsDropdown);
  downloadContainer.appendChild(downloadButton);
  return downloadContainer;
}

function injectFloatingButton() {
  if (document.querySelector(".claude-download-button")) {
    return false;
  }

  const downloadContainer = createDownloadContainer();
  downloadContainer.style.cssText =
    "position: fixed; bottom: 88px; right: 16px; z-index: 40; display: flex; align-items: center; gap: 8px; pointer-events: auto;";

  document.body.appendChild(downloadContainer);
  console.log(
    LOG_PREFIX,
    "button injected successfully (floating, bottom-right)",
  );
  return true;
}

function addDownloadButton() {
  if (document.querySelector(".claude-download-button")) {
    console.log(LOG_PREFIX, "injection skipped, button already exists");
    return false;
  }

  if (injectFloatingButton()) {
    return true;
  }

  console.warn(LOG_PREFIX, "no safe insertion target found");
  return false;
}

function createButton(text) {
  const button = document.createElement("button");
  button.className =
    "claude-download-button flex items-center rounded-md bg-gray-100 py-1 px-3 text-sm font-medium text-gray-800 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 shadow-md";
  button.type = "button";
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>${text}`;
  button.addEventListener("click", downloadArtifacts);
  return button;
}

function createOptionsDropdown() {
  const select = document.createElement("select");
  select.className =
    "claude-download-options rounded-md bg-gray-100 py-1 px-2 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 shadow-md";

  const flatOption = document.createElement("option");
  flatOption.value = "flat";
  flatOption.textContent = "Flat structure";

  const structuredOption = document.createElement("option");
  structuredOption.value = "structured";
  structuredOption.textContent = "Inferred structure";

  select.appendChild(flatOption);
  select.appendChild(structuredOption);

  return select;
}

function downloadArtifacts() {
  const uuid = extractChatUuid(window.location.href);
  if (!uuid) {
    createBanner("No conversation UUID found in URL.", "error", 3000);
    return;
  }

  console.log(LOG_PREFIX, "export requested for", uuid);
  const optionsDropdown = document.querySelector(".claude-download-options");
  const useDirectoryStructure = optionsDropdown?.value === "structured";

  chrome.runtime.sendMessage(
    {
      action: "downloadArtifacts",
      uuid: uuid,
      useDirectoryStructure: useDirectoryStructure,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message;
        console.log(LOG_PREFIX, "export failure:", msg);
        createBanner(msg, "error", 3000);
        return;
      }
      if (response?.success) {
        console.log(LOG_PREFIX, "export success:", response.message);
      } else if (response?.error) {
        console.log(LOG_PREFIX, "export failure:", response.error);
      }
    },
  );
}

let domObserver = null;

function startDomObserver() {
  if (domObserver) {
    return;
  }

  domObserver = new MutationObserver(() => {
    if (addDownloadButton()) {
      domObserver.disconnect();
      domObserver = null;
    }
  });

  domObserver.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
      console.warn(
        LOG_PREFIX,
        "MutationObserver timed out without finding container",
      );
    }
  }, 30000);
}

function checkAndAddShareButtons() {
  if (!isChatPage(window.location.href)) {
    console.log(LOG_PREFIX, "not a chat page, skipping button injection");
    return;
  }

  const uuid = extractChatUuid(window.location.href);
  if (uuid) {
    console.log(LOG_PREFIX, "extracted conversation UUID from URL:", uuid);
  }

  const maxAttempts = 15;
  let attempts = 0;

  function tryAddButtons() {
    if (document.querySelector(".claude-download-button")) {
      console.log(LOG_PREFIX, "injection skipped, button already exists");
      return;
    }

    attempts++;
    console.log(
      LOG_PREFIX,
      `attempting button injection (attempt ${attempts}/${maxAttempts})`,
    );

    if (addDownloadButton()) {
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tryAddButtons, 1000);
    } else {
      console.warn(
        LOG_PREFIX,
        `container not found after ${maxAttempts} attempts, starting MutationObserver`,
      );
      startDomObserver();
    }
  }

  tryAddButtons();
}

console.log(LOG_PREFIX, "content script loaded on", window.location.href);
checkAndAddShareButtons();

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "listenForPayload") {
    const eventName = `cad-payload-${request.uuid}`;
    console.log(LOG_PREFIX, "listening for page payload event:", eventName);
    document.addEventListener(
      eventName,
      (event) => {
        const detail = event.detail ?? {
          payload: null,
          error: "empty page payload event",
        };
        sendResponse(detail);
      },
      { once: true },
    );
    return true;
  }

  if (request.action === "artifactsProcessed") {
    if (request.success) {
      console.log(LOG_PREFIX, "export success:", request.message);
      createBanner(request.message, "success", 1000);
    } else if (request.failure) {
      console.log(LOG_PREFIX, "export failure:", request.message);
      createBanner(request.message, "error", 3000);
    } else if (request.message) {
      console.log(LOG_PREFIX, "export failure:", request.message);
      createBanner(request.message, "error", 3000);
    }
  } else if (request.action === "checkAndAddDownloadButton") {
    checkAndAddShareButtons();
  }
});
