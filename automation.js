// automation.js — lets a local script drive the extension by opening
//   https://claude.ai/#ceh=<token>&cmd=archive&uuids=a,b&root=…
//   https://claude.ai/#ceh=<token>&cmd=reload
// The token must match automation-token.txt in the extension folder (checked
// in background.js), so web pages cannot trigger anything.
(() => {
  if (!location.hash.startsWith("#ceh=")) return;
  const params = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  history.replaceState(null, "", location.pathname + location.search);
  chrome.runtime.sendMessage({ action: "automationCommand", params });
})();
