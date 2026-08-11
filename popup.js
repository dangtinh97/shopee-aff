"use strict";

const DEFAULT_TIMEOUT_MS = 10_000;
const CONFIG_STORAGE_KEY = "config";
const DEFAULT_CONFIG = {
  devMode: true
};

const urlInput = document.getElementById("url");
const subId1Input = document.getElementById("subId1");
const testModeInput = document.getElementById("testMode");
const runButton = document.getElementById("run");
const modeStatusOutput = document.getElementById("modeStatus");
const mqttStatusOutput = document.getElementById("mqttStatus");
const resultOutput = document.getElementById("result");

function setResult(message, state = "") {
  resultOutput.textContent = message;
  resultOutput.dataset.state = state;
}

function renderDevModeStatus(enabled) {
  modeStatusOutput.textContent = enabled
    ? "Developer Mode is ON.\n\nGenerate and MQTT requests are simulated only and will not be submitted to Shopee."
    : "Developer Mode is disabled.\n\nClicking Generate or sending a request via MQTT will submit the data to Shopee using your current logged-in account.";
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
    devMode: storedConfig.devMode ?? storedConfig.testMode ?? DEFAULT_CONFIG.devMode
  };
}

async function getDevMode() {
  const config = await getConfig();

  return Boolean(config.devMode);
}

async function setDevMode(enabled) {
  await chrome.storage.local.set({
    [CONFIG_STORAGE_KEY]: {
      devMode: enabled
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

runButton.addEventListener("click", async () => {
  const originalUrl = urlInput.value.trim();
  const subId1 = subId1Input.value.trim();

  runButton.disabled = true;
  setResult("Dang tao affiliate link...");

  try {
    assertShopeeUrl(originalUrl);

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
  } catch (error) {
    setResult(error.message || "Generate that bai.", "error");
  } finally {
    runButton.disabled = false;
  }
});

initTestModeSwitch();
refreshMqttStatus();
