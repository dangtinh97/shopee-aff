"use strict";

const EXTENSION_SOURCE = "shopee-affiliate-extension";
const PAGE_SOURCE = "shopee-affiliate-page";
const DEFAULT_TIMEOUT_MS = 20_000;

let injectPromise;

function createRequestId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function injectPageScript() {
  if (injectPromise) {
    return injectPromise;
  }

  injectPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");

    script.src = chrome.runtime.getURL("injected.js");
    script.async = false;

    script.addEventListener("load", () => {
      script.remove();
      resolve();
    }, { once: true });

    script.addEventListener("error", () => {
      script.remove();
      injectPromise = undefined;
      reject(new Error("Khong the inject injected.js vao page context."));
    }, { once: true });

    (document.head || document.documentElement).appendChild(script);
  });

  return injectPromise;
}

/**
 * Send the URL to injected.js and resolve with the AffiliateResult returned
 * from the page context.
 *
 * @param {{url: string, subId1?: string, testMode?: boolean}} params
 * @param {number} timeoutMs
 * @returns {Promise<{shortLink: string, longLink: string, failCode: number}>}
 */
async function generateAffiliateLink(params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await injectPageScript();

  const requestId = createRequestId();
  const contentTimeoutMs = Math.max(timeoutMs, DEFAULT_TIMEOUT_MS);
  // De injected.js luon timeout truoc content.js it nhat 4s, tranh race condition
  const injectedTimeoutMs = Math.max(contentTimeoutMs - 4_000, 12_000);

  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
    };

    const handleMessage = (event) => {
      if (event.source !== window) {
        return;
      }

      const message = event.data;

      if (
        message?.source !== PAGE_SOURCE ||
        message.requestId !== requestId
      ) {
        return;
      }

      cleanup();

      if (message.type === "GENERATE_DONE") {
        resolve(message.payload);
        return;
      }

      reject(new Error(message.error || "Generate that bai."));
    };

    window.addEventListener("message", handleMessage);

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout khi cho Shopee Affiliate response."));
    }, contentTimeoutMs);

    window.postMessage({
      source: EXTENSION_SOURCE,
      type: "GENERATE",
      requestId,
      payload: {
        url: params.url,
        subId1: params.subId1 || "",
        testMode: Boolean(params.testMode),
        timeoutMs: injectedTimeoutMs
      }
    }, window.location.origin);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    ![
      "shopee-affiliate-extension-popup",
      "shopee-affiliate-extension-background"
    ].includes(message?.source)
  ) {
    return false;
  }

  if (message.type === "PING_READINESS") {
    const isLogin =
      window.location.href.includes("/buyer/login") ||
      window.location.href.includes("/login") ||
      window.location.href.includes("accounts.shopee.vn");
    const ready = Boolean(document.querySelector("#customLink_original_url"));

    sendResponse({
      ok: true,
      ready,
      isLogin,
      url: window.location.href
    });
    return false;
  }

  if (message.type !== "GENERATE_AFFILIATE_LINK") {
    return false;
  }

  const isLogin =
    window.location.href.includes("/buyer/login") ||
    window.location.href.includes("/login") ||
    window.location.href.includes("accounts.shopee.vn");

  if (isLogin) {
    sendResponse({
      error: "SESSION_EXPIRED: Phien dang nhap Shopee da het han. Vui long dang nhap lai."
    });
    return false;
  }

  generateAffiliateLink({
    url: message.payload.url,
    subId1: message.payload.subId1 || "",
    testMode: Boolean(message.payload.testMode)
  }, message.payload.timeoutMs || DEFAULT_TIMEOUT_MS)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        error: error.message || "Generate that bai."
      });
    });

  return true;
});
