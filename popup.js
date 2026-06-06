const CHAT_UUID_PATTERN = /\/chat\/([0-9a-f-]{36})/i;

document.getElementById("export").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const uuid = tab?.url?.match(CHAT_UUID_PATTERN)?.[1];

  if (!uuid) {
    window.close();
    return;
  }

  const useDirectoryStructure =
    document.getElementById("structure").value === "structured";

  chrome.runtime.sendMessage({
    action: "downloadArtifacts",
    uuid: uuid,
    tabId: tab.id,
    useDirectoryStructure: useDirectoryStructure,
  });

  window.close();
});
