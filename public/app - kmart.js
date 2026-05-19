const formFields = {
  firstName: document.getElementById("firstName"),
  lastName: document.getElementById("lastName"),
  email: document.getElementById("email")
};

let syncTimer = null;
let watermark = null;
let lastRenderedImageActivityId = null;
const druidRuntime = {
  chatBearerToken: null,
  directLineToken: null,
  gptBearerToken: null,
  conversationId: null,
  getStatusUrl: null
};
let consecutiveFailures = 0;

installNetworkTokenCapture();

document.addEventListener("DOMContentLoaded", () => {
  runAutoFillSync();
});

async function runAutoFillSync() {
  if (shouldStopAutofillSync()) {
    clearTimeout(syncTimer);
    syncTimer = null;
    return;
  }

  try {
    const response = await fetch("/api/autofill-from-druid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        watermark,
        currentForm: getCurrentFormState(),
        chatBearerToken: druidRuntime.chatBearerToken,
        directLineToken: druidRuntime.directLineToken,
        gptBearerToken: druidRuntime.gptBearerToken,
        conversationId: druidRuntime.conversationId,
        getStatusUrl: druidRuntime.getStatusUrl
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      const details = payload?.details ? ` Details: ${payload.details}` : "";
      throw new Error(`${payload?.error || "Autofill sync failed."}${details}`);
    }

    consecutiveFailures = 0;
    watermark = payload?.watermark || watermark;
    const updates = payload?.updates || [];
    for (const update of updates) {
      applyExtractedFields(update.extracted || {});
    }
  } catch (err) {
    consecutiveFailures += 1;
    console.error("Autofill sync error:", err.message);
  } finally {
    if (shouldStopAutofillSync()) {
      clearTimeout(syncTimer);
      syncTimer = null;
      return;
    }
    clearTimeout(syncTimer);
    const delay = consecutiveFailures > 3 ? 4500 : 1800;
    syncTimer = setTimeout(runAutoFillSync, delay);
  }
}

function shouldStopAutofillSync() {
  // Stop once email and at least one name field are filled
  const emailFilled = Boolean(formFields.email?.value?.trim());
  const nameFilled = Boolean(formFields.firstName?.value?.trim() || formFields.lastName?.value?.trim());
  return emailFilled && nameFilled;
}

function installNetworkTokenCapture() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const [input, init] = args;
      const url = typeof input === "string" ? input : input?.url;
      captureFromRequest(url, init?.headers);
    } catch {
      // Ignore capture errors; do not block app behavior.
    }
    return originalFetch(...args);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__captureUrl = typeof url === "string" ? url : "";
    this.__captureHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (typeof name === "string" && typeof value === "string") {
        this.__captureHeaders[name.toLowerCase()] = value;
      }
    } catch {
      // Ignore.
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      captureFromRequest(this.__captureUrl, this.__captureHeaders);
    } catch {
      // Ignore capture errors.
    }
    return originalSend.call(this, body);
  };
}

function captureFromRequest(url, headers) {
  if (!url || typeof url !== "string") return;
  const bearer = getBearerToken(headers);
  const normalizedUrl = url.toLowerCase();

  if (normalizedUrl.includes("/api/services/app/chat/authorizeanonymousasync")) {
    if (bearer) {
      druidRuntime.chatBearerToken = bearer;
      maybePromoteToGptToken(bearer);
    }
  }

  if (normalizedUrl.includes("/getstatus?")) {
    const statusUrl = getAbsoluteUrl(url);
    if (statusUrl) druidRuntime.getStatusUrl = statusUrl;
    const conversationFromQuery = getQueryParam(statusUrl || url, "ConversationId");
    if (isLikelyConversationId(conversationFromQuery)) {
      druidRuntime.conversationId = conversationFromQuery;
    }
    if (bearer) {
      druidRuntime.chatBearerToken = bearer;
      maybePromoteToGptToken(bearer);
    }
  }

  const match = url.match(/\/directline\/conversations\/([^/]+)\/activities/i);
  if (match?.[1]) {
    const candidateConversationId = decodeURIComponent(match[1]);
    if (isLikelyConversationId(candidateConversationId)) {
      druidRuntime.conversationId = candidateConversationId;
    }
    if (bearer) {
      druidRuntime.directLineToken = bearer;
      maybePromoteToGptToken(bearer);
    }
  }

  if (normalizedUrl.includes("/openai/deployments/")) {
    if (bearer) {
      druidRuntime.gptBearerToken = bearer;
    }
  }
}

function getBearerToken(headers) {
  const authValue = readHeader(headers, "authorization");
  if (!authValue || typeof authValue !== "string") return null;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;
  return match[1].trim();
}

function readHeader(headers, key) {
  if (!headers) return null;
  const lowerKey = key.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(key) || headers.get(lowerKey);
  }

  if (Array.isArray(headers)) {
    const hit = headers.find(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        entry[0].toLowerCase() === lowerKey
    );
    return hit ? hit[1] : null;
  }

  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof k === "string" && k.toLowerCase() === lowerKey) {
        return typeof v === "string" ? v : null;
      }
    }
  }

  return null;
}

function getAbsoluteUrl(url) {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return null;
  }
}

function getQueryParam(url, key) {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.searchParams.get(key);
  } catch {
    return null;
  }
}

function isLikelyConversationId(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 10) return false;
  if (!trimmed.includes("-")) return false;
  return /^[A-Za-z0-9._|-]+$/.test(trimmed);
}

function maybePromoteToGptToken(token) {
  if (!token || typeof token !== "string") return;
  if (!isLikelyLlmToken(token)) return;
  if (druidRuntime.gptBearerToken === token) return;
  druidRuntime.gptBearerToken = token;
}

function isLikelyLlmToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return false;
    const payloadJson = base64UrlDecode(parts[1]);
    const payload = JSON.parse(payloadJson);
    const aud = typeof payload?.aud === "string" ? payload.aud.trim() : "";
    const llmClaims =
      typeof payload?.["Druid.LLM.UserClaims"] === "string"
        ? payload["Druid.LLM.UserClaims"].trim()
        : "";
    const iss = typeof payload?.iss === "string" ? payload.iss.trim() : "";
    return aud === "Druid.LLM" || !!llmClaims || iss === "Druid AI";
  } catch {
    return false;
  }
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return atob(padded);
}

function getCurrentFormState() {
  // Combine firstName + lastName into a single name for the server
  const firstName = normalizeString(formFields.firstName?.value);
  const lastName = normalizeString(formFields.lastName?.value);
  const name = [firstName, lastName].filter(Boolean).join(" ") || null;

  return {
    name,
    email: normalizeString(formFields.email?.value)
  };
}

function applyExtractedFields(extracted) {
  // Split incoming name into firstName / lastName if provided
  if (extracted.name) {
    const parts = extracted.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts.slice(1).join(" ");
      if (formFields.firstName && !formFields.firstName.value) formFields.firstName.value = first;
      if (formFields.lastName && !formFields.lastName.value) formFields.lastName.value = last;
    } else if (parts.length === 1) {
      if (formFields.firstName && !formFields.firstName.value) formFields.firstName.value = parts[0];
    }
  }

  if (extracted.email && formFields.email && !formFields.email.value) {
    formFields.email.value = extracted.email;
  }
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
