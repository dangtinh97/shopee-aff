"use strict";

const DEFAULT_TIMEOUT_MS = 10_000;
const MQTT_REQUEST_TOPIC = "shopee/aff";
const MQTT_RESPONSE_TOPIC = "shopee/aff/response";
const MQTT_ERROR_LINK_TOPIC = "error_link";
const MQTT_BROKER_URL = "ws://myoupip.com:8083";
const MQTT_KEEPALIVE_SECONDS = 30;
const MQTT_RECONNECT_DELAY_MS = 3_000;
const MQTT_HEARTBEAT_ALARM = "mqtt-heartbeat";
const MQTT_HEARTBEAT_PERIOD_MINUTES = 1;
const LINK_CHECK_ALARM = "link-check";
const LINK_CHECK_PERIOD_MINUTES = 0.5;
const LINK_CHECK_STATUS_STORAGE_KEY = "linkCheckStatus";
const AFFILIATE_STATS_STORAGE_KEY = "affiliateStats";
const FAILED_LINKS_STORAGE_KEY = "failedLinks";
const MQTT_QUEUE_DELAY_MIN_MS = 3_000;
const MQTT_QUEUE_DELAY_MAX_MS = 5_000;
const AFFILIATE_RELOAD_ALARM = "affiliate-hourly-reload";
const AFFILIATE_RELOAD_CHECK_PERIOD_MINUTES = 1;
const AFFILIATE_RELOAD_INTERVAL_MS = 60 * 60 * 1000;
const MAX_FAILED_LINKS = 100;
const REQUIRED_CUSTOM_LINK_URL = "https://affiliate.shopee.vn/offer/custom_link";
const CONFIG_STORAGE_KEY = "config";
const DEFAULT_CONFIG = {
  devMode: true,
  linkCheckEnabled: false
};

let mqttSocket;
let mqttPacketId = 1;
let mqttPingTimer;
let mqttReconnectTimer;
let mqttConnected = false;
let pendingMqttPublishes = [];
let mqttRequestQueue = [];
let mqttQueueProcessing = false;
let activeGenerateCount = 0;
let reloadInProgress = false;
let statsUpdatePromise = Promise.resolve();
let mqttStatus = {
  connected: false,
  brokerUrl: MQTT_BROKER_URL,
  lastEvent: "init",
  updatedAt: Date.now()
};
const DEFAULT_AFFILIATE_STATS = {
  createdCount: 0,
  receivedCount: 0,
  failedCount: 0,
  inProgressCount: 0,
  lastCreatedAt: undefined,
  lastFailedAt: undefined,
  lastReceivedAt: undefined,
  lastReloadAt: undefined,
  reloadWaiting: false,
  reloadWaitReason: "",
  updatedAt: Date.now()
};

function setMqttStatus(statusPatch) {
  mqttStatus = {
    ...mqttStatus,
    ...statusPatch,
    updatedAt: Date.now()
  };

  chrome.storage.local.set({
    mqttStatus
  });
}

function isMqttSocketOpen() {
  return mqttSocket?.readyState === WebSocket.OPEN && mqttConnected;
}

async function findAffiliateTab() {
  const tabs = await chrome.tabs.query({
    url: "https://affiliate.shopee.vn/*"
  });

  const tab = tabs.find((candidate) => candidate.id);

  if (!tab?.id) {
    throw new Error("Khong tim thay tab affiliate.shopee.vn dang mo.");
  }

  return tab;
}

function normalizeMqttPayload(payload) {
  if (!payload?.url) {
    throw new Error("MQTT payload thieu url.");
  }

  return {
    url: String(payload.url),
    subId1: payload.subid ? String(payload.subid) : ""
  };
}

async function getConfig() {
  const values = await chrome.storage.local.get({
    [CONFIG_STORAGE_KEY]: DEFAULT_CONFIG
  });
  const storedConfig = values[CONFIG_STORAGE_KEY] || {};

  return {
    ...DEFAULT_CONFIG,
    ...storedConfig,
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

async function getAffiliateStats() {
  const values = await chrome.storage.local.get({
    [AFFILIATE_STATS_STORAGE_KEY]: DEFAULT_AFFILIATE_STATS
  });

  return {
    ...DEFAULT_AFFILIATE_STATS,
    ...(values[AFFILIATE_STATS_STORAGE_KEY] || {})
  };
}

async function updateAffiliateStats(updater) {
  const nextUpdate = statsUpdatePromise.then(async () => {
    const currentStats = await getAffiliateStats();
    const statsPatch = typeof updater === "function"
      ? updater(currentStats)
      : updater;
    const nextStats = {
      ...currentStats,
      ...statsPatch,
      updatedAt: Date.now()
    };

    await chrome.storage.local.set({
      [AFFILIATE_STATS_STORAGE_KEY]: nextStats
    });

    return nextStats;
  });

  statsUpdatePromise = nextUpdate.catch(() => undefined);

  return nextUpdate;
}

async function setInProgressCount() {
  await updateAffiliateStats({
    inProgressCount: activeGenerateCount + mqttRequestQueue.length
  });
}

function getRequestUrlFromPayload(payload) {
  return payload?.url ? String(payload.url) : "";
}

async function saveFailedLink(failure) {
  const values = await chrome.storage.local.get({
    [FAILED_LINKS_STORAGE_KEY]: []
  });
  const failedLinks = Array.isArray(values[FAILED_LINKS_STORAGE_KEY])
    ? values[FAILED_LINKS_STORAGE_KEY]
    : [];
  const now = Date.now();
  const nextFailedLinks = [
    {
      id: `${now}-${crypto.randomUUID()}`,
      url: getRequestUrlFromPayload(failure.request) || failure.url || "",
      subId1: failure.request?.subid || failure.request?.subId1 || "",
      request: failure.request,
      requestTopic: failure.requestTopic,
      error: failure.error || "Generate that bai.",
      createdAt: now
    },
    ...failedLinks
  ].slice(0, MAX_FAILED_LINKS);

  await chrome.storage.local.set({
    [FAILED_LINKS_STORAGE_KEY]: nextFailedLinks
  });

  await updateAffiliateStats((stats) => ({
    failedCount: Number(stats.failedCount || 0) + 1,
    lastFailedAt: now
  }));
}

async function generateFromMqttPayload(payload) {
  const tab = await findAffiliateTab();
  const params = normalizeMqttPayload(payload);
  activeGenerateCount += 1;
  await setInProgressCount();

  let response;

  try {
    response = await sendGenerateMessageToTab(tab.id, params);
  } finally {
    activeGenerateCount = Math.max(activeGenerateCount - 1, 0);
    await setInProgressCount();
  }

  if (response?.error) {
    throw new Error(response.error);
  }

  await updateAffiliateStats((stats) => ({
    createdCount: Number(stats.createdCount || 0) + 1,
    lastCreatedAt: Date.now()
  }));

  return response;
}

async function sendGenerateMessageToTab(tabId, params) {
  const config = await getConfig();
  const message = {
    source: "shopee-affiliate-extension-background",
    type: "GENERATE_AFFILIATE_LINK",
    payload: {
      url: params.url,
      subId1: params.subId1,
      testMode: Boolean(config.devMode),
      timeoutMs: DEFAULT_TIMEOUT_MS
    }
  };

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: {
        tabId
      },
      files: [
        "content.js"
      ]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function handleMqttMessage(topic, payload) {
  if (topic !== MQTT_REQUEST_TOPIC) {
    return undefined;
  }

  try {
    const result = await generateFromMqttPayload(payload);

    return {
      topic: MQTT_RESPONSE_TOPIC,
      requestTopic: topic,
      request: payload,
      response: result
    };
  } catch (error) {
    const errorMessage = error.message || "Generate that bai.";

    await saveFailedLink({
      request: payload,
      requestTopic: topic,
      error: errorMessage
    });
    publishErrorLink({
      topic: MQTT_ERROR_LINK_TOPIC,
      requestTopic: topic,
      request: payload,
      error: errorMessage,
      checkedAt: Date.now()
    });

    return {
      topic: MQTT_RESPONSE_TOPIC,
      requestTopic: topic,
      request: payload,
      error: errorMessage
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getNextMqttQueueDelayMs() {
  return Math.floor(
    MQTT_QUEUE_DELAY_MIN_MS +
      Math.random() * (MQTT_QUEUE_DELAY_MAX_MS - MQTT_QUEUE_DELAY_MIN_MS + 1)
  );
}

function enqueueMqttRequest(message) {
  mqttRequestQueue.push(message);
  updateAffiliateStats((stats) => ({
    receivedCount: Number(stats.receivedCount || 0) + 1,
    lastReceivedAt: Date.now()
  }));
  setInProgressCount();
  processMqttQueue();
}

async function processMqttQueue() {
  if (mqttQueueProcessing) {
    return;
  }

  mqttQueueProcessing = true;

  try {
    while (mqttRequestQueue.length > 0) {
      const message = mqttRequestQueue.shift();
      await setInProgressCount();
      const response = await handleMqttMessage(message.topic, message.payload);

      if (response) {
        publishMqttResponse(response);
      }

      if (mqttRequestQueue.length > 0) {
        await sleep(getNextMqttQueueDelayMs());
      }
    }
  } finally {
    mqttQueueProcessing = false;
    await setInProgressCount();

    if (mqttRequestQueue.length > 0) {
      processMqttQueue();
    }
  }
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

function encodeMqttString(value) {
  const bytes = encodeUtf8(value);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function encodeRemainingLength(length) {
  const encoded = [];
  let value = length;

  do {
    let byte = value % 128;
    value = Math.floor(value / 128);

    if (value > 0) {
      byte |= 128;
    }

    encoded.push(byte);
  } while (value > 0);

  return encoded;
}

function buildPacket(packetTypeAndFlags, variableHeaderAndPayload = []) {
  return new Uint8Array([
    packetTypeAndFlags,
    ...encodeRemainingLength(variableHeaderAndPayload.length),
    ...variableHeaderAndPayload
  ]);
}

function buildConnectPacket() {
  const clientId = `shopee-aff-ext-${crypto.randomUUID()}`;
  const variableHeader = [
    ...encodeMqttString("MQTT"),
    4,
    0b00000010,
    MQTT_KEEPALIVE_SECONDS >> 8,
    MQTT_KEEPALIVE_SECONDS & 0xff
  ];
  const payload = encodeMqttString(clientId);

  return buildPacket(0x10, [...variableHeader, ...payload]);
}

function buildSubscribePacket(topic) {
  const packetId = mqttPacketId++;

  if (mqttPacketId > 0xffff) {
    mqttPacketId = 1;
  }

  return buildPacket(0x82, [
    packetId >> 8,
    packetId & 0xff,
    ...encodeMqttString(topic),
    0
  ]);
}

function buildPublishPacket(topic, payload) {
  const payloadBytes = encodeUtf8(JSON.stringify(payload));

  return buildPacket(0x30, [
    ...encodeMqttString(topic),
    ...payloadBytes
  ]);
}

function parseRemainingLength(bytes, offset) {
  let multiplier = 1;
  let value = 0;
  let cursor = offset;
  let encodedByte;

  do {
    encodedByte = bytes[cursor++];
    value += (encodedByte & 127) * multiplier;
    multiplier *= 128;
  } while ((encodedByte & 128) !== 0);

  return {
    value,
    bytesRead: cursor - offset
  };
}

function parsePublishPacket(bytes) {
  const remaining = parseRemainingLength(bytes, 1);
  let cursor = 1 + remaining.bytesRead;
  const topicLength = (bytes[cursor] << 8) + bytes[cursor + 1];

  cursor += 2;

  const topic = decodeUtf8(bytes.slice(cursor, cursor + topicLength));

  cursor += topicLength;

  const payloadText = decodeUtf8(bytes.slice(cursor, 1 + remaining.bytesRead + remaining.value));

  return {
    topic,
    payload: JSON.parse(payloadText)
  };
}

function sendMqttPacket(packet) {
  if (mqttSocket?.readyState === WebSocket.OPEN) {
    mqttSocket.send(packet);
  }
}

function publishMqttResponse(response, options = {}) {
  const sent = publishMqttTopic(MQTT_RESPONSE_TOPIC, response);

  if (
    sent ||
    options.trackSendFailure === false ||
    response?.error ||
    !response?.request?.url
  ) {
    return;
  }

  const errorPayload = {
    topic: MQTT_ERROR_LINK_TOPIC,
    requestTopic: response.requestTopic || MQTT_REQUEST_TOPIC,
    request: response.request,
    error: "Da tao link nhung chua gui duoc MQTT response.",
    checkedAt: Date.now()
  };

  saveFailedLink(errorPayload);
  publishErrorLink(errorPayload);
}

function publishMqttTopic(topic, payload) {
  if (isMqttSocketOpen()) {
    sendMqttPacket(buildPublishPacket(topic, payload));
    return true;
  }

  pendingMqttPublishes.push({
    topic,
    payload
  });
  ensureMqttConnected();
  return false;
}

function publishErrorLink(payload) {
  publishMqttTopic(MQTT_ERROR_LINK_TOPIC, payload);
  publishMqttResponse({
    ...payload,
    topic: MQTT_ERROR_LINK_TOPIC
  }, {
    trackSendFailure: false
  });
}

function flushPendingMqttPublishes() {
  if (!isMqttSocketOpen() || pendingMqttPublishes.length === 0) {
    return;
  }

  const publishes = pendingMqttPublishes;

  pendingMqttPublishes = [];

  publishes.forEach(({ topic, payload }) => {
    sendMqttPacket(buildPublishPacket(topic, payload));
  });
}

function startMqttKeepalive() {
  clearInterval(mqttPingTimer);
  mqttPingTimer = setInterval(() => {
    sendMqttPacket(buildPacket(0xc0));
  }, MQTT_KEEPALIVE_SECONDS * 500);
}

function scheduleMqttReconnect() {
  clearInterval(mqttPingTimer);
  mqttConnected = false;
  setMqttStatus({
    connected: false,
    lastEvent: "reconnect_scheduled"
  });

  if (mqttReconnectTimer) {
    return;
  }

  mqttReconnectTimer = setTimeout(() => {
    mqttReconnectTimer = undefined;
    connectMqtt();
  }, MQTT_RECONNECT_DELAY_MS);
}

async function handleIncomingPublish(bytes) {
  let message;

  try {
    message = parsePublishPacket(bytes);
  } catch (error) {
    publishMqttResponse({
      topic: MQTT_RESPONSE_TOPIC,
      error: `Invalid MQTT payload: ${error.message}`
    });
    return;
  }

  if (message.topic === MQTT_REQUEST_TOPIC) {
    enqueueMqttRequest(message);
  }
}

function handleMqttPacket(bytes) {
  const packetType = bytes[0] >> 4;

  if (packetType === 2) {
    mqttConnected = true;
    setMqttStatus({
      connected: true,
      lastEvent: "connected"
    });
    sendMqttPacket(buildSubscribePacket(MQTT_REQUEST_TOPIC));
    flushPendingMqttPublishes();
    startMqttKeepalive();
    return;
  }

  if (packetType === 3) {
    handleIncomingPublish(bytes);
  }
}

function connectMqtt() {
  if (
    mqttSocket &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(mqttSocket.readyState)
  ) {
    return;
  }

  clearTimeout(mqttReconnectTimer);
  mqttReconnectTimer = undefined;
  setMqttStatus({
    connected: false,
    lastEvent: "connecting"
  });

  try {
    mqttSocket = new WebSocket(MQTT_BROKER_URL, "mqtt");
  } catch (error) {
    setMqttStatus({
      connected: false,
      lastEvent: `websocket_create_error: ${error.message}`
    });
    scheduleMqttReconnect();
    return;
  }

  mqttSocket.binaryType = "arraybuffer";

  mqttSocket.addEventListener("open", () => {
    setMqttStatus({
      connected: false,
      lastEvent: "websocket_open"
    });
    sendMqttPacket(buildConnectPacket());
  });

  mqttSocket.addEventListener("message", (event) => {
    handleMqttPacket(new Uint8Array(event.data));
  });

  mqttSocket.addEventListener("close", () => {
    setMqttStatus({
      connected: false,
      lastEvent: "websocket_close"
    });
    scheduleMqttReconnect();
  });

  mqttSocket.addEventListener("error", () => {
    setMqttStatus({
      connected: false,
      lastEvent: "websocket_error"
    });
    scheduleMqttReconnect();
  });
}

function ensureMqttConnected() {
  if (!isMqttSocketOpen()) {
    connectMqtt();
  }
}

function setupMqttHeartbeat() {
  chrome.alarms.create(MQTT_HEARTBEAT_ALARM, {
    periodInMinutes: MQTT_HEARTBEAT_PERIOD_MINUTES
  });
}

function setupLinkCheckAlarm() {
  chrome.alarms.create(LINK_CHECK_ALARM, {
    periodInMinutes: LINK_CHECK_PERIOD_MINUTES
  });
}

function setupAffiliateReloadAlarm() {
  chrome.alarms.create(AFFILIATE_RELOAD_ALARM, {
    periodInMinutes: AFFILIATE_RELOAD_CHECK_PERIOD_MINUTES
  });
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  return tab;
}

function isRequiredCustomLinkUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const requiredUrl = new URL(REQUIRED_CUSTOM_LINK_URL);

    return (
      parsedUrl.origin === requiredUrl.origin &&
      parsedUrl.pathname === requiredUrl.pathname
    );
  } catch (_error) {
    return false;
  }
}

async function disableLinkCheck() {
  await setConfig({
    linkCheckEnabled: false
  });
}

async function setLinkCheckStatus(statusPatch) {
  await chrome.storage.local.set({
    [LINK_CHECK_STATUS_STORAGE_KEY]: {
      ...statusPatch,
      updatedAt: Date.now()
    }
  });
}

async function checkCurrentTabLink(tabSnapshot) {
  const config = await getConfig();

  if (!config.linkCheckEnabled) {
    const result = {
      enabled: false,
      ok: true,
      reason: "disabled"
    };

    await setLinkCheckStatus(result);
    return result;
  }

  const tab = tabSnapshot || await getCurrentTab();
  const currentUrl = tab?.url || "";

  if (isRequiredCustomLinkUrl(currentUrl)) {
    const result = {
      enabled: true,
      ok: true,
      currentUrl,
      tabId: tab?.id
    };

    await setLinkCheckStatus(result);
    return result;
  }

  const result = {
    enabled: false,
    ok: false,
    topic: MQTT_ERROR_LINK_TOPIC,
    requiredUrl: REQUIRED_CUSTOM_LINK_URL,
    currentUrl,
    tabId: tab?.id,
    checkedAt: Date.now()
  };

  publishErrorLink(result);
  await saveFailedLink({
    url: currentUrl,
    requestTopic: MQTT_ERROR_LINK_TOPIC,
    error: "Tab affiliate dang sai link."
  });
  await disableLinkCheck();
  await setLinkCheckStatus(result);

  return result;
}

async function getAffiliateProcessingStatus() {
  const stats = await getAffiliateStats();
  const inProgressCount = activeGenerateCount + mqttRequestQueue.length;

  return {
    inProgressCount,
    mqttQueueProcessing,
    queueLength: mqttRequestQueue.length,
    activeGenerateCount,
    lastReloadAt: stats.lastReloadAt
  };
}

async function reloadAffiliateTabIfIdle(force = false) {
  if (reloadInProgress) {
    return;
  }

  const stats = await getAffiliateStats();
  const now = Date.now();

  if (!force && !stats.lastReloadAt) {
    await updateAffiliateStats({
      lastReloadAt: now
    });
    return;
  }

  if (
    !force &&
    stats.lastReloadAt &&
    now - stats.lastReloadAt < AFFILIATE_RELOAD_INTERVAL_MS
  ) {
    return;
  }

  const processingStatus = await getAffiliateProcessingStatus();

  if (processingStatus.inProgressCount > 0 || processingStatus.mqttQueueProcessing) {
    await updateAffiliateStats({
      inProgressCount: processingStatus.inProgressCount,
      reloadWaiting: true,
      reloadWaitReason: "Dang xu ly link, doi xong moi reload."
    });
    return;
  }

  reloadInProgress = true;

  try {
    const tab = await findAffiliateTab();

    await chrome.tabs.reload(tab.id);
    await updateAffiliateStats({
      lastReloadAt: now,
      reloadWaiting: false,
      reloadWaitReason: "",
      inProgressCount: 0
    });
  } catch (error) {
    await updateAffiliateStats({
      reloadWaiting: false,
      reloadWaitReason: error.message || "Khong reload duoc tab affiliate."
    });
  } finally {
    reloadInProgress = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupMqttHeartbeat();
  setupLinkCheckAlarm();
  setupAffiliateReloadAlarm();
  ensureMqttConnected();
  setInProgressCount();
});

chrome.runtime.onStartup.addListener(() => {
  setupMqttHeartbeat();
  setupLinkCheckAlarm();
  setupAffiliateReloadAlarm();
  ensureMqttConnected();
  setInProgressCount();
});

chrome.runtime.onSuspend.addListener(() => {
  clearInterval(mqttPingTimer);
  mqttConnected = false;
  setMqttStatus({
    connected: false,
    lastEvent: "service_worker_suspended"
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MQTT_HEARTBEAT_ALARM) {
    ensureMqttConnected();
    return;
  }

  if (alarm.name === LINK_CHECK_ALARM) {
    ensureMqttConnected();
    checkCurrentTabLink().catch((error) => {
      publishErrorLink({
        topic: MQTT_ERROR_LINK_TOPIC,
        error: error.message || "Check link that bai.",
        checkedAt: Date.now()
      });
    });
    return;
  }

  if (alarm.name === AFFILIATE_RELOAD_ALARM) {
    reloadAffiliateTabIfIdle();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source !== "shopee-affiliate-extension-popup") {
    return false;
  }

  if (message.type === "GET_MQTT_STATUS") {
    ensureMqttConnected();
    sendResponse(mqttStatus);

    return false;
  }

  if (message.type === "GET_AFFILIATE_STATS") {
    Promise.all([
      getAffiliateStats(),
      chrome.storage.local.get({
        [FAILED_LINKS_STORAGE_KEY]: []
      }),
      getAffiliateProcessingStatus()
    ])
      .then(([stats, values, processingStatus]) => {
        sendResponse({
          ...stats,
          ...processingStatus,
          failedLinks: values[FAILED_LINKS_STORAGE_KEY] || []
        });
      })
      .catch((error) => sendResponse({
        error: error.message || "Khong doc duoc thong ke."
      }));

    return true;
  }

  if (message.type === "RECORD_GENERATE_RESULT") {
    const payload = message.payload || {};

    if (payload.ok) {
      updateAffiliateStats((stats) => ({
        createdCount: Number(stats.createdCount || 0) + 1,
        lastCreatedAt: Date.now()
      }))
        .then(() => sendResponse({
          ok: true
        }))
        .catch((error) => sendResponse({
          error: error.message || "Khong luu duoc thong ke."
        }));
      return true;
    }

    saveFailedLink({
      url: payload.url,
      request: {
        url: payload.url,
        subId1: payload.subId1
      },
      requestTopic: "manual",
      error: payload.error || "Generate that bai."
    })
      .then(() => sendResponse({
        ok: true
      }))
      .catch((error) => sendResponse({
        error: error.message || "Khong luu duoc link loi."
      }));

    return true;
  }

  if (message.type === "SET_MANUAL_PROCESSING") {
    activeGenerateCount = message.payload?.active
      ? activeGenerateCount + 1
      : Math.max(activeGenerateCount - 1, 0);
    setInProgressCount()
      .then(() => sendResponse({
        ok: true
      }))
      .catch((error) => sendResponse({
        error: error.message || "Khong cap nhat duoc trang thai xu ly."
      }));

    return true;
  }

  if (message.type === "REMOVE_FAILED_LINK") {
    const failedLinkId = message.payload?.id;

    chrome.storage.local.get({
      [FAILED_LINKS_STORAGE_KEY]: []
    })
      .then((values) => {
        const failedLinks = Array.isArray(values[FAILED_LINKS_STORAGE_KEY])
          ? values[FAILED_LINKS_STORAGE_KEY]
          : [];

        return chrome.storage.local.set({
          [FAILED_LINKS_STORAGE_KEY]: failedLinks.filter((link) => link.id !== failedLinkId)
        });
      })
      .then(() => sendResponse({
        ok: true
      }))
      .catch((error) => sendResponse({
        error: error.message || "Khong xoa duoc link loi."
      }));

    return true;
  }

  if (message.type === "CLEAR_FAILED_LINKS") {
    chrome.storage.local.set({
      [FAILED_LINKS_STORAGE_KEY]: []
    })
      .then(() => sendResponse({
        ok: true
      }))
      .catch((error) => sendResponse({
        error: error.message || "Khong xoa duoc danh sach link loi."
      }));

    return true;
  }

  if (message.type === "RETRY_FAILED_LINK") {
    const failedLink = message.payload?.failedLink;

    generateFromMqttPayload({
      url: failedLink?.url,
      subid: failedLink?.subId1
    })
      .then((result) => sendResponse({
        ok: true,
        response: result
      }))
      .catch(async (error) => {
        await saveFailedLink({
          request: {
            url: failedLink?.url,
            subid: failedLink?.subId1
          },
          requestTopic: MQTT_REQUEST_TOPIC,
          error: error.message || "Retry that bai."
        });
        sendResponse({
          error: error.message || "Retry that bai."
        });
      });

    return true;
  }

  if (message.type === "CHECK_CURRENT_TAB_LINK_NOW") {
    ensureMqttConnected();
    checkCurrentTabLink(message.payload?.tab)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "Check link that bai."
      }));

    return true;
  }

  return false;
});

setupMqttHeartbeat();
setupLinkCheckAlarm();
setupAffiliateReloadAlarm();
ensureMqttConnected();
