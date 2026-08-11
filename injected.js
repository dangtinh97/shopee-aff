(() => {
  "use strict";

  const EXTENSION_SOURCE = "shopee-affiliate-extension";
  const PAGE_SOURCE = "shopee-affiliate-page";
  const DEFAULT_TIMEOUT_MS = 10_000;
  const CLOSE_MODAL_DELAY_MS = 1_000;
  const MOCK_AFFILIATE_RESULT = {
    shortLink: "https://s.shopee.vn/2g9WR7chzl",
    longLink: "https://shopee.vn/universal-link/K%C3%ADnh-C%C6%B0%E1%BB%9Dng-L%E1%BB%B1c-Ch%E1%BB%91ng-Nh%C3%ACn-Tr%E1%BB%99m-c%C3%B3-Khung-T%E1%BB%B1-D%C3%A1n-D%C3%A0nh-Cho-iphone-7plus-x-xsmax-11-12-13-14-15-16-17-pro-max-plus-i.204928811.21149022412?extraParams=%7B%22display_model_id%22%3A301769461082%2C%22model_selection_logic%22%3Anull%7D&gads_t_sig=gqRjZGVrxHCFomtpsTE0MjUxOnRzc19zZGtfa2V5omt20QABpGFsZ2_SAAAAZKNkZWvAomN0xEAAAAAM_NxfHGgeczprZR4Q8tPoOfvwhbtN63JlB369xGJA1mbqBWuW2sVWxQjSJT_xT_mbG0_W5kumedB_GGTjqmNpcGhlcnRleHTFAQQAAAAMPGuhpltG-KjGIlRXK5hauwPELCgRiv-mp_B19NpKgBezjg2sm4goqSBKscUN3Uz54NiWlYE1RoG49OGM-PFlAEewTxICNrRLBqW-AnDGqMyTVyab7ZVSt1V6f6tgGPo6-8o13l1-scM9uZjqf0B93CEcBqiGKejyXkmbB159aOdsqNNBaCak6JNjq2FeNJSSzAa3Sc5xQIQUm6nX5tFFHjUB1xgS7Y_jXIuDHubbE_OmXZmKdR55p-Xc482eXqtqhCjTXKT6AavLctcGxylgx1qYlJLJsfQgKNBqkT1NV9GVtT-w7YmBHGn2xNqWLjjiz7R4tOhzhdfE3A4Mw3d0wA&utm_campaign=-&utm_content=dangtinh97----&utm_medium=affiliates&utm_source=an_17366610104",
    failCode: 0
  };

  const state = window.__shopeeAffiliateState || {
    pendingRequests: [],
    listenerAttached: false
  };

  state.originalFetch ||= window.fetch.bind(window);
  state.originalXhrOpen ||= XMLHttpRequest.prototype.open;
  state.originalXhrSend ||= XMLHttpRequest.prototype.send;

  window.__shopeeAffiliateState = state;

  function getRequestUrl(input) {
    return typeof input === "string" ? input : input?.url;
  }

  function isTargetRequest(input) {
    const url = getRequestUrl(input);

    if (!url) {
      return false;
    }

    try {
      const parsedUrl = new URL(url, window.location.href);

      return (
        parsedUrl.origin === "https://affiliate.shopee.vn" &&
        parsedUrl.pathname === "/api/v3/gql" &&
        parsedUrl.searchParams.get("q") === "batchCustomLink"
      );
    } catch (_error) {
      return false;
    }
  }

  function findBatchCustomLinkPayload(json) {
    if (json?.data?.batchCustomLink?.[0]) {
      return json.data.batchCustomLink[0];
    }

    if (Array.isArray(json)) {
      for (const item of json) {
        const payload = findBatchCustomLinkPayload(item);

        if (payload) {
          return payload;
        }
      }
    }

    return undefined;
  }

  function normalizeAffiliateResult(json) {
    const item = findBatchCustomLinkPayload(json);

    if (!item) {
      throw new Error("Response khong co batchCustomLink[0].");
    }

    return {
      shortLink: String(item.shortLink || ""),
      longLink: String(item.longLink || ""),
      failCode: Number(item.failCode ?? -1)
    };
  }

  function handleNetworkJson(json) {
    try {
      resolveNextPending(normalizeAffiliateResult(json));
    } catch (error) {
      rejectNextPending(error);
    }
  }

  function handleNetworkText(text) {
    try {
      handleNetworkJson(JSON.parse(text));
    } catch (error) {
      rejectNextPending(error);
    }
  }

  function resolveNextPending(result) {
    const pending = state.pendingRequests.shift();

    if (!pending) {
      return;
    }

    closeAffiliateModalLater();
    pending.resolve(result);
  }

  function rejectNextPending(error) {
    const pending = state.pendingRequests.shift();

    if (!pending) {
      return;
    }

    pending.reject(error);
  }

  function hookFetchOnce() {
    if (state.fetchHooked === true) {
      return;
    }

    state.fetchHooked = true;
    window.__shopeeAffiliateHooked = true;

    window.fetch = async (...args) => {
      const response = await state.originalFetch(...args);

      if (!isTargetRequest(args[0])) {
        return response;
      }

      response.clone().json()
        .then(handleNetworkJson)
        .catch(rejectNextPending);

      return response;
    };
  }

  function hookXhrOnce() {
    if (state.xhrHooked === true) {
      return;
    }

    state.xhrHooked = true;

    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      this.__shopeeAffiliateUrl = url;
      return state.originalXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function send(...args) {
      if (isTargetRequest(this.__shopeeAffiliateUrl)) {
        this.addEventListener("loadend", () => {
          const response = this.response;

          if (response && typeof response === "object") {
            handleNetworkJson(response);
            return;
          }

          try {
            if (!this.responseText) {
              rejectNextPending(new Error("XHR response rong."));
              return;
            }

            handleNetworkText(this.responseText);
          } catch (error) {
            rejectNextPending(error);
          }
        }, { once: true });
      }

      return state.originalXhrSend.apply(this, args);
    };
  }

  function hookNetworkOnce() {
    hookFetchOnce();
    hookXhrOnce();
  }

  function closeAffiliateModalLater() {
    window.setTimeout(() => {
      const closeButtons = [...document.querySelectorAll("button.ant-modal-close")];
      const closeButton = closeButtons
        .reverse()
        .find((button) => button.offsetParent !== null);

      if (closeButton instanceof HTMLElement) {
        closeButton.click();
      }
    }, CLOSE_MODAL_DELAY_MS);
  }

  function getValueSetter(element) {
    if (element instanceof HTMLTextAreaElement) {
      return Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
    }

    if (element instanceof HTMLInputElement) {
      return Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
    }

    return undefined;
  }

  function setReactFieldValue(wrapper, field, value) {
    const setter = getValueSetter(field);

    if (!setter) {
      throw new Error("Khong tim thay field value setter.");
    }

    field.focus();
    setter.call(field, value);

    field.dispatchEvent(new Event("input", {
      bubbles: true
    }));

    field.dispatchEvent(new Event("change", {
      bubbles: true
    }));

    // Some Ant Design/React wrappers mirror the value on the container.
    wrapper.setAttribute("value", value);
  }

  function setReactInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;

    if (!setter) {
      throw new Error("Khong tim thay input value setter.");
    }

    input.focus();
    setter.call(input, value);

    input.dispatchEvent(new Event("input", {
      bubbles: true
    }));

    input.dispatchEvent(new Event("change", {
      bubbles: true
    }));
  }

  async function waitForElement(selector, timeoutMs) {
    const existingElement = document.querySelector(selector);

    if (existingElement) {
      return existingElement;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Khong tim thay element: ${selector}`));
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);

        if (!element) {
          return;
        }

        clearTimeout(timeoutId);
        observer.disconnect();
        resolve(element);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  function getFieldFromElement(element) {
    if (
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLInputElement
    ) {
      return element;
    }

    return element.querySelector("textarea, input");
  }

  async function fillWrappedField(selector, value, timeoutMs, required = true) {
    if (!value && !required) {
      return undefined;
    }

    const element = await waitForElement(selector, timeoutMs);
    const field = getFieldFromElement(element);

    if (!field) {
      throw new Error(`Khong tim thay input/textarea trong ${selector}.`);
    }

    setReactFieldValue(element, field, value);

    return {
      selector,
      tagName: field.tagName.toLowerCase(),
      value
    };
  }

  async function fillSubId1(subId1, timeoutMs) {
    if (!subId1) {
      return undefined;
    }

    const element = await waitForElement("#customLink_sub_id1", timeoutMs);
    const input = element instanceof HTMLInputElement
      ? element
      : element.querySelector("input");

    if (!input) {
      throw new Error("Khong tim thay input #customLink_sub_id1.");
    }

    setReactInputValue(input, subId1);

    window.__shopeeAffiliateLastInject = {
      ...(window.__shopeeAffiliateLastInject || {}),
      subId1: {
        selector: "#customLink_sub_id1",
        tagName: input.tagName.toLowerCase(),
        value: input.value
      }
    };

    return {
      selector: "#customLink_sub_id1",
      tagName: input.tagName.toLowerCase(),
      value: input.value
    };
  }

  async function fillUrlAndSubmit(url, subId1, timeoutMs, testMode) {
    const injectedFields = [
      await fillWrappedField("#customLink_original_url", url, timeoutMs),
      await fillSubId1(subId1, timeoutMs)
    ].filter(Boolean);

    window.__shopeeAffiliateLastInject = {
      ...(window.__shopeeAffiliateLastInject || {}),
      fields: injectedFields
    };

    if (testMode) {
      return {
        submitted: false,
        injectedFields
      };
    }

    const button = await waitForElement(
      ".ant-form-item-children button",
      timeoutMs
    );

    button.click();

    return {
      submitted: true,
      injectedFields
    };
  }

  /**
   * Generate one Shopee Affiliate link by driving the Shopee Affiliate SPA.
   *
   * @param {string} url
   * @param {string} subId1
   * @param {boolean} testMode
   * @param {number} timeoutMs
   * @returns {Promise<{shortLink: string, longLink: string, failCode: number}>}
   */
  async function generateAffiliateLink(
    url,
    subId1 = "",
    testMode = true,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    hookNetworkOnce();

    if (testMode) {
      await fillUrlAndSubmit(url, subId1, timeoutMs, true);
      return MOCK_AFFILIATE_RESULT;
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        settled = true;
        clearTimeout(timeoutId);
      };

      const timeoutId = setTimeout(() => {
        cleanup();

        const index = state.pendingRequests.indexOf(pendingRequest);

        if (index !== -1) {
          state.pendingRequests.splice(index, 1);
        }

        reject(new Error("Timeout khi cho request batchCustomLink."));
      }, timeoutMs);

      const pendingRequest = {
        resolve: (result) => {
          if (settled) {
            return;
          }

          cleanup();
          resolve(result);
        },
        reject: (error) => {
          if (settled) {
            return;
          }

          cleanup();
          reject(error);
        }
      };

      state.pendingRequests.push(pendingRequest);

      fillUrlAndSubmit(url, subId1, timeoutMs, false).catch((error) => {
        const index = state.pendingRequests.indexOf(pendingRequest);

        if (index !== -1) {
          state.pendingRequests.splice(index, 1);
        }

        pendingRequest.reject(error);
      });
    });
  }

  async function handleGenerateMessage(message) {
    try {
      const result = await generateAffiliateLink(
        message.payload.url,
        message.payload.subId1 || "",
        Boolean(message.payload.testMode),
        message.payload.timeoutMs || DEFAULT_TIMEOUT_MS
      );

      window.postMessage({
        source: PAGE_SOURCE,
        type: "GENERATE_DONE",
        requestId: message.requestId,
        payload: result
      }, window.location.origin);
    } catch (error) {
      window.postMessage({
        source: PAGE_SOURCE,
        type: "GENERATE_ERROR",
        requestId: message.requestId,
        error: error.message || "Generate that bai."
      }, window.location.origin);
    }
  }

  if (!state.listenerAttached) {
    window.addEventListener("message", (event) => {
      if (event.source !== window) {
        return;
      }

      const message = event.data;

      if (
        message?.source !== EXTENSION_SOURCE ||
        message.type !== "GENERATE"
      ) {
        return;
      }

      handleGenerateMessage(message);
    });

    state.listenerAttached = true;
  }

  window.generateAffiliateLink = generateAffiliateLink;
  hookNetworkOnce();
})();
