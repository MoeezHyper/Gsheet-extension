// Only enable the toolbar button on Google Sheets pages; it is greyed out everywhere else.
const SHEETS_URL = "https://docs.google.com/spreadsheets/*";
const SHEETS_RULE = {
  conditions: [
    new chrome.declarativeContent.PageStateMatcher({
      pageUrl: { schemes: ["https"], hostEquals: "docs.google.com", pathPrefix: "/spreadsheets/" }
    })
  ],
  actions: [new chrome.declarativeContent.ShowAction()]
};

function installRules() {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([SHEETS_RULE]);
  });
}

// Manifest content scripts only reach pages loaded after install/update, so inject into
// Sheets tabs that are already open (a newer copy replaces any orphaned older copy).
async function injectIntoOpenSheets() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SHEETS_URL });
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    const target = { tabId: tab.id };
    chrome.scripting.insertCSS({ target, files: ["content.css"] }).catch(() => {});
    chrome.scripting.executeScript({ target, files: ["settings.js", "content.js"] }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  installRules();
  injectIntoOpenSheets();
});
chrome.runtime.onStartup.addListener(installRules);
