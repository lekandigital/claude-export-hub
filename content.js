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

function findButtonContainer() {
  const selectors = [
    ".flex.min-w-0.items-center.max-md\\:text-sm",
    "header .flex.items-center",
    "header [class*='flex'][class*='items-center']",
  ];

  for (const selector of selectors) {
    const container = document.querySelector(selector);
    if (container) {
      return container;
    }
  }

  const shareButton = Array.from(
    document.querySelectorAll("header button, header a"),
  ).find((el) => el.textContent.trim().toLowerCase().includes("share"));

  if (shareButton) {
    return (
      shareButton.closest(".flex.items-center") ||
      shareButton.parentElement
    );
  }

  const header = document.querySelector("header");
  if (header) {
    return header.querySelector(".flex.items-center") || header;
  }

  return null;
}

function addDownloadButton() {
  const buttonContainer = findButtonContainer();

  if (
    buttonContainer &&
    !buttonContainer.querySelector(".claude-download-button")
  ) {
    const downloadContainer = document.createElement("div");
    downloadContainer.className =
      "claude-download-container ml-1 flex items-center";

    const downloadButton = createButton("Download artifacts");
    const optionsDropdown = createOptionsDropdown();

    downloadContainer.appendChild(optionsDropdown);
    downloadContainer.appendChild(downloadButton);
    buttonContainer.appendChild(downloadContainer);
    console.log(LOG_PREFIX, "button injected successfully");
    return true;
  }

  return false;
}

function createButton(text) {
  const button = document.createElement("button");
  button.className =
    "claude-download-button ml-1 flex items-center rounded-md bg-gray-100 py-1 px-3 text-sm font-medium text-gray-800 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2";
  button.type = "button";
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>${text}`;
  button.addEventListener("click", downloadArtifacts);
  return button;
}

function createOptionsDropdown() {
  const select = document.createElement("select");
  select.className =
    "claude-download-options rounded-md bg-gray-100 py-1 px-2 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2";

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

  const optionsDropdown = document.querySelector(".claude-download-options");
  const useDirectoryStructure = optionsDropdown?.value === "structured";

  chrome.runtime.sendMessage({
    action: "downloadArtifacts",
    uuid: uuid,
    useDirectoryStructure: useDirectoryStructure,
  });
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
      console.warn(LOG_PREFIX, "MutationObserver timed out without finding container");
    }
  }, 30000);
}

function checkAndAddShareButtons() {
  if (!isChatPage(window.location.href)) {
    console.log(LOG_PREFIX, "not a chat page, skipping button injection");
    return;
  }

  const maxAttempts = 15;
  let attempts = 0;

  function tryAddButtons() {
    if (document.querySelector(".claude-download-button")) {
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

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "artifactsProcessed") {
    if (request.success) {
      createBanner(request.message, "success", 1000);
    } else if (request.failure) {
      createBanner(request.message, "error", 3000);
    } else if (request.message) {
      createBanner(request.message, "error", 3000);
    }
  } else if (request.action === "checkAndAddDownloadButton") {
    checkAndAddShareButtons();
  }
});
