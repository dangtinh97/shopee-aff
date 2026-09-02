"use strict";

const DEFAULT_TIMEOUT_MS = 10_000;
const CONFIG_STORAGE_KEY = "config";
const LINK_CHECK_STATUS_STORAGE_KEY = "linkCheckStatus";
const AFFILIATE_STATS_STORAGE_KEY = "affiliateStats";
const FAILED_LINKS_STORAGE_KEY = "failedLinks";
const DEFAULT_CONFIG = {
  devMode: true,
  linkCheckEnabled: false
};

const urlInput = document.getElementById("url");
const subId1Input = document.getElementById("subId1");
const testModeInput = document.getElementById("testMode");
const linkCheckInput = document.getElementById("linkCheckMode");
const runButton = document.getElementById("run");
const modeStatusOutput = document.getElementById("modeStatus");
const linkCheckStatusOutput = document.getElementById("linkCheckStatus");
const mqttStatusOutput = document.getElementById("mqttStatus");
const createdCountOutput = document.getElementById("createdCount");
const inProgressCountOutput = document.getElementById("inProgressCount");
const failedCountOutput = document.getElementById("failedCount");
const failedLinksOutput = document.getElementById("failedLinks");
const clearFailedLinksButton = document.getElementById("clearFailedLinks");
const resultOutput = document.getElementById("result");

function setResult(message, state = "") {
  resultOutput.textContent = message;
  resultOutput.dataset.state = state;
}

function renderDevModeStatus(enabled) {
  modeStatusOutput.textContent = enabled
    ? "Dev mode ON: requests are simulated."
    : "Dev mode OFF: requests submit to Shopee.";
  modeStatusOutput.dataset.state = enabled ? "dev" : "live";
}

function renderMqttStatus(status) {
  const connected = Boolean(status?.connected);

  if (status?.workerUnavailable) {
    mqttStatusOutput.textContent = `MQTT worker unavailable: ${status.lastEvent}`;
    mqttStatusOutput.dataset.state = "offline";
    return;
  }

  mqttStatusOutput.textContent = connected
    ? `MQTT connected: ${status.brokerUrl}`
    : `MQTT reconnecting: ${status?.lastEvent || "unknown"}`;
  mqttStatusOutput.dataset.state = connected ? "connected" : "offline";
}

function renderLinkCheckStatus(enabled, status) {
  if (status?.ok === false) {
    linkCheckStatusOutput.textContent = `Wrong tab. Sent topic: ${status.topic || "error_link"}. Check is OFF.`;
    linkCheckStatusOutput.dataset.state = "error";
    return;
  }

  if (enabled) {
    linkCheckStatusOutput.textContent = "Link check ON: current tab is valid.";
    linkCheckStatusOutput.dataset.state = "enabled";
    return;
  }

  linkCheckStatusOutput.textContent = "Link check OFF.";
  linkCheckStatusOutput.dataset.state = "disabled";
}

function renderAffiliateStats(stats) {
  createdCountOutput.textContent = String(stats?.createdCount || 0);
  inProgressCountOutput.textContent = String(stats?.inProgressCount || 0);
  failedCountOutput.textContent = String(stats?.failedCount || 0);

  const failedLinks = Array.isArray(stats?.failedLinks)
    ? stats.failedLinks
    : [];

  clearFailedLinksButton.disabled = failedLinks.length === 0;
  failedLinksOutput.textContent = "";

  if (failedLinks.length === 0) {
    const empty = document.createElement("div");

    empty.className = "failed-empty";
    empty.textContent = "Chua co link loi.";
    failedLinksOutput.appendChild(empty);
    return;
  }

  failedLinks.forEach((failedLink) => {
    const item = document.createElement("div");
    const url = document.createElement("div");
    const error = document.createElement("div");
    const actions = document.createElement("div");
    const retryButton = document.createElement("button");
    const removeButton = document.createElement("button");

    item.className = "failed-item";
    url.className = "failed-url";
    url.textContent = failedLink.url || "(khong co url)";
    error.className = "failed-error";
    error.textContent = failedLink.error || "Generate that bai.";
    actions.className = "failed-actions";

    retryButton.className = "secondary-button";
    retryButton.type = "button";
    retryButton.textContent = "Retry";
    retryButton.dataset.action = "retry";
    retryButton.dataset.id = failedLink.id;

    removeButton.className = "secondary-button";
    removeButton.type = "button";
    removeButton.textContent = "Xoa";
    removeButton.dataset.action = "remove";
    removeButton.dataset.id = failedLink.id;

    actions.append(retryButton, removeButton);
    item.append(url, error, actions);
    failedLinksOutput.appendChild(item);
  });
}

async function refreshMqttStatus() {
  try {
    const status = await chrome.runtime.sendMessage({
      source: "shopee-affiliate-extension-popup",
      type: "GET_MQTT_STATUS"
    });

    renderMqttStatus(status);
  } catch (error) {
    const values = await chrome.storage.local.get({
      mqttStatus: undefined
    });
    const lastStatus = values.mqttStatus;

    renderMqttStatus({
      ...(lastStatus || {}),
      connected: false,
      workerUnavailable: true,
      lastEvent: error.message || "status_error"
    });
  }
}

async function refreshLinkCheckStatus() {
  const values = await chrome.storage.local.get({
    [LINK_CHECK_STATUS_STORAGE_KEY]: undefined
  });
  const status = values[LINK_CHECK_STATUS_STORAGE_KEY];

  renderLinkCheckStatus(await getLinkCheckMode(), status);
}

async function refreshAffiliateStats() {
  try {
    const stats = await chrome.runtime.sendMessage({
      source: "shopee-affiliate-extension-popup",
      type: "GET_AFFILIATE_STATS"
    });

    if (stats?.error) {
      throw new Error(stats.error);
    }

    renderAffiliateStats(stats);
  } catch (_error) {
    const values = await chrome.storage.local.get({
      [AFFILIATE_STATS_STORAGE_KEY]: {},
      [FAILED_LINKS_STORAGE_KEY]: []
    });

    renderAffiliateStats({
      ...(values[AFFILIATE_STATS_STORAGE_KEY] || {}),
      failedLinks: values[FAILED_LINKS_STORAGE_KEY] || []
    });
  }
}

async function recordGenerateResult(payload) {
  try {
    await chrome.runtime.sendMessage({
      source: "shopee-affiliate-extension-popup",
      type: "RECORD_GENERATE_RESULT",
      payload
    });
  } catch (_error) {
    // The popup can still show the result even if the service worker is waking up.
  }
}

async function setManualProcessing(active) {
  try {
    await chrome.runtime.sendMessage({
      source: "shopee-affiliate-extension-popup",
      type: "SET_MANUAL_PROCESSING",
      payload: {
        active
      }
    });
  } catch (_error) {
    // Reload protection is best-effort when the service worker is starting.
  }
}

function assertShopeeUrl(url) {
  if (!url) {
    throw new Error("Vui long nhap Shopee URL.");
  }

  const parsedUrl = new URL(url);

  if (!parsedUrl.hostname.endsWith("shopee.vn")) {
    throw new Error("URL phai thuoc domain shopee.vn.");
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("Khong tim thay tab hien tai.");
  }

  if (!tab.url?.startsWith("https://affiliate.shopee.vn/offer/custom_link")) {
    throw new Error("Hay mo trang https://affiliate.shopee.vn/offer/custom_link truoc khi generate.");
  }

  return tab;
}

async function getConfig() {
  const values = await chrome.storage.local.get({
    [CONFIG_STORAGE_KEY]: DEFAULT_CONFIG
  });
  const storedConfig = values[CONFIG_STORAGE_KEY] || {};

  return {
    ...DEFAULT_CONFIG,
    ...storedConfig,
    // Backward compatible with the previous config shape.
    devMode: storedConfig.devMode ?? storedConfig.testMode ?? DEFAULT_CONFIG.devMode,
    linkCheckEnabled: storedConfig.linkCheckEnabled ?? DEFAULT_CONFIG.linkCheckEnabled
  };
}

async function setConfig(configPatch) {
  const config = await getConfig();

  await chrome.storage.local.set({
    [CONFIG_STORAGE_KEY]: {
      ...config,
      ...configPatch
    }
  });
}

async function getDevMode() {
  const config = await getConfig();

  return Boolean(config.devMode);
}

async function setDevMode(enabled) {
  await setConfig({
    devMode: enabled
  });
}

async function getLinkCheckMode() {
  const config = await getConfig();

  return Boolean(config.linkCheckEnabled);
}

async function setLinkCheckMode(enabled) {
  await setConfig({
    linkCheckEnabled: enabled
  });
}

async function checkCurrentTabLinkNow() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return chrome.runtime.sendMessage({
    source: "shopee-affiliate-extension-popup",
    type: "CHECK_CURRENT_TAB_LINK_NOW",
    payload: {
      tab: tab
        ? {
          id: tab.id,
          url: tab.url
        }
        : undefined
    }
  });
}

async function initTestModeSwitch() {
  const initialDevMode = await getDevMode();

  testModeInput.checked = initialDevMode;
  renderDevModeStatus(initialDevMode);

  testModeInput.addEventListener("change", async () => {
    const enabled = testModeInput.checked;

    renderDevModeStatus(enabled);

    await setDevMode(enabled);

    // Re-read persisted config so reopening the popup reflects the saved value.
    testModeInput.checked = await getDevMode();
    renderDevModeStatus(testModeInput.checked);
  });
}

async function initLinkCheckSwitch() {
  const initialLinkCheckMode = await getLinkCheckMode();

  linkCheckInput.checked = initialLinkCheckMode;
  renderLinkCheckStatus(initialLinkCheckMode);

  linkCheckInput.addEventListener("change", async () => {
    const enabled = linkCheckInput.checked;

    renderLinkCheckStatus(enabled);

    await setLinkCheckMode(enabled);

    if (enabled) {
      const status = await checkCurrentTabLinkNow();

      if (status?.ok === false) {
        renderLinkCheckStatus(false, status);
        return;
      }
    }

    linkCheckInput.checked = await getLinkCheckMode();
    await refreshLinkCheckStatus();
  });
}

async function generateFromActiveTab(url, subId1) {
  const tab = await getActiveTab();
  const devMode = await getDevMode();

  const response = await chrome.tabs.sendMessage(tab.id, {
    source: "shopee-affiliate-extension-popup",
    type: "GENERATE_AFFILIATE_LINK",
    payload: {
      url,
      subId1,
      testMode: devMode,
      timeoutMs: DEFAULT_TIMEOUT_MS
    }
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  return response;
}

async function getFailedLinkById(id) {
  const values = await chrome.storage.local.get({
    [FAILED_LINKS_STORAGE_KEY]: []
  });
  const failedLinks = Array.isArray(values[FAILED_LINKS_STORAGE_KEY])
    ? values[FAILED_LINKS_STORAGE_KEY]
    : [];

  return failedLinks.find((failedLink) => failedLink.id === id);
}

async function removeFailedLink(id) {
  const response = await chrome.runtime.sendMessage({
    source: "shopee-affiliate-extension-popup",
    type: "REMOVE_FAILED_LINK",
    payload: {
      id
    }
  });

  if (response?.error) {
    throw new Error(response.error);
  }
}

async function retryFailedLink(failedLink) {
  const response = await chrome.runtime.sendMessage({
    source: "shopee-affiliate-extension-popup",
    type: "RETRY_FAILED_LINK",
    payload: {
      failedLink
    }
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  return response.response;
}

runButton.addEventListener("click", async () => {
  const originalUrl = urlInput.value.trim();
  const subId1 = subId1Input.value.trim();
  let manualProcessingStarted = false;

  runButton.disabled = true;
  setResult("Dang tao affiliate link...");

  try {
    assertShopeeUrl(originalUrl);

    await setManualProcessing(true);
    manualProcessingStarted = true;
    const result = await generateFromActiveTab(originalUrl, subId1);

    if (result?.submitted === false) {
      setResult(
        [
          "Da inject vao form. Dev mode dang bat, khong submit.",
          ...result.injectedFields.map((field) => (
            `${field.selector} (${field.tagName}): ${field.value}`
          ))
        ].join("\n"),
        "success"
      );
      return;
    }

    setResult(
      [
        `shortLink: ${result.shortLink}`,
        `longLink: ${result.longLink}`,
        `failCode: ${result.failCode}`
      ].join("\n"),
      "success"
    );
    await recordGenerateResult({
      ok: true,
      url: originalUrl,
      subId1
    });
    await refreshAffiliateStats();
  } catch (error) {
    setResult(error.message || "Generate that bai.", "error");
    if (originalUrl) {
      await recordGenerateResult({
        ok: false,
        url: originalUrl,
        subId1,
        error: error.message || "Generate that bai."
      });
      await refreshAffiliateStats();
    }
  } finally {
    if (manualProcessingStarted) {
      await setManualProcessing(false);
    }
    runButton.disabled = false;
  }
});

failedLinksOutput.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;

  button.disabled = true;

  try {
    if (action === "remove") {
      await removeFailedLink(id);
      setResult("Da xoa link loi.", "success");
      await refreshAffiliateStats();
      return;
    }

    const failedLink = await getFailedLinkById(id);

    if (!failedLink) {
      throw new Error("Khong tim thay link loi.");
    }

    setResult("Dang retry link loi...");

    const result = await retryFailedLink(failedLink);

    await removeFailedLink(id);
    setResult(
      [
        "Retry thanh cong.",
        `shortLink: ${result.shortLink}`,
        `longLink: ${result.longLink}`,
        `failCode: ${result.failCode}`
      ].join("\n"),
      "success"
    );
    await refreshAffiliateStats();
  } catch (error) {
    setResult(error.message || "Xu ly link loi that bai.", "error");
    await refreshAffiliateStats();
  } finally {
    button.disabled = false;
  }
});

clearFailedLinksButton.addEventListener("click", async () => {
  clearFailedLinksButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      source: "shopee-affiliate-extension-popup",
      type: "CLEAR_FAILED_LINKS"
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    setResult("Da xoa danh sach link loi.", "success");
    await refreshAffiliateStats();
  } catch (error) {
    setResult(error.message || "Khong xoa duoc danh sach link loi.", "error");
  } finally {
    clearFailedLinksButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[CONFIG_STORAGE_KEY]) {
    const config = {
      ...DEFAULT_CONFIG,
      ...(changes[CONFIG_STORAGE_KEY].newValue || {})
    };

    linkCheckInput.checked = Boolean(config.linkCheckEnabled);
  }

  if (changes[CONFIG_STORAGE_KEY] || changes[LINK_CHECK_STATUS_STORAGE_KEY]) {
    refreshLinkCheckStatus();
  }

  if (changes[AFFILIATE_STATS_STORAGE_KEY] || changes[FAILED_LINKS_STORAGE_KEY]) {
    refreshAffiliateStats();
  }
});

initTestModeSwitch();
initLinkCheckSwitch();
refreshMqttStatus();
refreshLinkCheckStatus();
refreshAffiliateStats();
