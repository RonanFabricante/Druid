// ── DOM references ──────────────────────────────────────────────────────────
const uploadedImagePreview = document.getElementById("uploadedImagePreview");
const uploadedImageHint    = document.getElementById("uploadedImageHint");
const ocrNameField         = document.getElementById("ocrName");
const ocrPassportIdField   = document.getElementById("ocrPassportId");

// ── Runtime state ────────────────────────────────────────────────────────────
let syncTimer = null;
let watermark = null;
let lastRenderedImageActivityId = null;
const druidRuntime = {
  chatBearerToken: null,
  directLineToken: null,
  gptBearerToken:  null,
  conversationId:  null,
  getStatusUrl:    null
};
let consecutiveFailures = 0;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
installNetworkTokenCapture();

document.addEventListener("DOMContentLoaded", () => {
  runAutoFillSync();
});

// ── Sync loop ─────────────────────────────────────────────────────────────────
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
        gptBearerToken:  druidRuntime.gptBearerToken,
        conversationId:  druidRuntime.conversationId,
        getStatusUrl:    druidRuntime.getStatusUrl
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

    applyUploadedImages(payload?.uploadedImages || []);
    applyImageExtraction(payload?.imageExtraction || null);

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

// Stop polling only when the entire form is complete — all sections including support person.
function shouldStopAutofillSync() {
  const firstName  = getFieldValue("firstName");
  const lastName   = getFieldValue("lastName");
  const dob        = getFieldValue("dateOfBirth");
  const traits     = getCheckedValues("personalityTraits");
  const important  = getFieldValue("importantThingsRightNow");
  const music      = getFieldValue("favouriteSongOrMusic");
  const worries    = getCheckedValues("worryTypes");
  const worried    = getFieldValue("worriedOrUpsetDetails");
  const coping     = getCheckedValues("copingStrategies");
  const support    = getCheckedValues("supportPersonActions");
  return Boolean(
    firstName && lastName && dob &&
    traits.length >= 1 &&
    important && music &&
    (worries.length >= 1 || worried) &&
    coping.length >= 1 &&
    support.length >= 1
  );
}

// ── Read current form state ───────────────────────────────────────────────────
function getCurrentFormState() {
  return {
    // Identity
    firstName:   getFieldValue("firstName"),
    lastName:    getFieldValue("lastName"),
    dateOfBirth: getFieldValue("dateOfBirth"),
    facility:    getFieldValue("facility"),
    wrb:         getFieldValue("wrb"),

    // Personality traits
    personalityTraits: getCheckedValues("personalityTraits"),

    // Life history
    importantThingsRightNow: getFieldValue("importantThingsRightNow"),
    favouriteSongOrMusic:    getFieldValue("favouriteSongOrMusic"),

    // Worries & coping
    worryTypes:           getCheckedValues("worryTypes"),
    worriedOrUpsetDetails: getFieldValue("worriedOrUpsetDetails"),
    copingStrategies:     getCheckedValues("copingStrategies"),
    copingDistractWith:   getFieldValue("copingDistractWith"),
    copingOther:          getFieldValue("copingOther"),

    // Support person
    supportPersonActions:     getCheckedValues("supportPersonActions"),
    supportPersonActionsOther: getFieldValue("supportPersonActionsOther")
  };
}

// ── Apply extracted fields to DOM ─────────────────────────────────────────────
function applyExtractedFields(extracted) {
  // Identity — plain text inputs
  setFieldValue("firstName",   extracted.firstName);
  setFieldValue("lastName",    extracted.lastName);
  setFieldValue("dateOfBirth", extracted.dateOfBirth
    ? formatDateForDisplay(extracted.dateOfBirth)
    : null);
  setFieldValue("facility",    extracted.facility);
  setFieldValue("wrb",         extracted.wrb);

  // Personality traits — checkboxes (array)
  applyCheckboxArray("personalityTraits", extracted.personalityTraits);

  // Life history — textareas
  setFieldValue("importantThingsRightNow", extracted.importantThingsRightNow);
  setFieldValue("favouriteSongOrMusic",    extracted.favouriteSongOrMusic);

  // Worries & coping — checkboxes + textareas
  applyCheckboxArray("worryTypes",       extracted.worryTypes);
  setFieldValue("worriedOrUpsetDetails", extracted.worriedOrUpsetDetails);
  applyCheckboxArray("copingStrategies", extracted.copingStrategies);
  setFieldValue("copingDistractWith",    extracted.copingDistractWith);
  setFieldValue("copingOther",           extracted.copingOther);

  // Support person — checkboxes + text
  applyCheckboxArray("supportPersonActions", extracted.supportPersonActions);
  setFieldValue("supportPersonActionsOther", extracted.supportPersonActionsOther);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get value of an input or textarea by id. */
function getFieldValue(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const v = (el.value || "").trim();
  return v || null;
}

/** Set value of an input or textarea by id (only if non-empty and not already set). */
function setFieldValue(id, value) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.value.trim()) {
    el.value = value;
  }
}

/** Return array of checked values for a named checkbox group. */
function getCheckedValues(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`))
    .map((el) => el.value);
}

/**
 * Check all checkboxes in `name` group whose value appears in `values` array.
 * Does not uncheck already-checked boxes (additive).
 */
function applyCheckboxArray(name, values) {
  if (!Array.isArray(values) || !values.length) return;
  for (const value of values) {
    const el = document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
    if (el && !el.checked) el.checked = true;
  }
}

/**
 * Convert YYYY-MM-DD (server format) to "DD MMM YYYY" for display,
 * or return the original string if it can't be parsed.
 */
function formatDateForDisplay(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return dateStr;
  const iso = dateStr.trim();
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const year  = match[1];
  const month = months[parseInt(match[2], 10) - 1] || match[2];
  const day   = parseInt(match[3], 10);
  return `${day} ${month} ${year}`;
}

// ── Uploaded image display ────────────────────────────────────────────────────
function applyUploadedImages(images) {
  if (!uploadedImagePreview || !uploadedImageHint) return;
  if (!Array.isArray(images) || !images.length) return;

  const latest = images[images.length - 1];
  const imageUrl = normalizeImageDataUrl(latest?.dataUrl);
  if (!imageUrl) return;

  const activityId = normalizeString(latest?.activityId);
  if (activityId && activityId === lastRenderedImageActivityId) return;

  uploadedImagePreview.src = imageUrl;
  uploadedImagePreview.hidden = false;
  if (uploadedImageHint) uploadedImageHint.hidden = true;
  lastRenderedImageActivityId = activityId || imageUrl;
}

function normalizeImageDataUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (/^data:image\//i.test(normalized)) return normalized;
  if (/^https?:\/\/\S+/i.test(normalized)) return normalized;
  return null;
}

// ── OCR / passport extraction ─────────────────────────────────────────────────
function applyImageExtraction(extraction) {
  if (!ocrNameField || !ocrPassportIdField) return;
  const name       = normalizeString(extraction?.name);
  const passportId = normalizeString(extraction?.passportId);
  ocrNameField.value       = name       || "";
  ocrPassportIdField.value = passportId || "";
}

// ── Network token capture (unchanged) ────────────────────────────────────────
function installNetworkTokenCapture() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const [input, init] = args;
      const url = typeof input === "string" ? input : input?.url;
      captureFromRequest(url, init?.headers);
    } catch { /* silent */ }
    return originalFetch(...args);
  };

  const originalOpen             = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend             = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__captureUrl     = typeof url === "string" ? url : "";
    this.__captureHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (typeof name === "string" && typeof value === "string") {
        this.__captureHeaders[name.toLowerCase()] = value;
      }
    } catch { /* silent */ }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try { captureFromRequest(this.__captureUrl, this.__captureHeaders); } catch { /* silent */ }
    return originalSend.call(this, body);
  };
}

function captureFromRequest(url, headers) {
  if (!url || typeof url !== "string") return;
  const bearer        = getBearerToken(headers);
  const normalizedUrl = url.toLowerCase();

  if (normalizedUrl.includes("/api/services/app/chat/authorizeanonymousasync")) {
    if (bearer) { druidRuntime.chatBearerToken = bearer; maybePromoteToGptToken(bearer); }
  }

  if (normalizedUrl.includes("/getstatus?")) {
    const statusUrl = getAbsoluteUrl(url);
    if (statusUrl) druidRuntime.getStatusUrl = statusUrl;
    const conversationFromQuery = getQueryParam(statusUrl || url, "ConversationId");
    if (isLikelyConversationId(conversationFromQuery)) druidRuntime.conversationId = conversationFromQuery;
    if (bearer) { druidRuntime.chatBearerToken = bearer; maybePromoteToGptToken(bearer); }
  }

  const match = url.match(/\/directline\/conversations\/([^/]+)\/activities/i);
  if (match?.[1]) {
    const candidateConversationId = decodeURIComponent(match[1]);
    if (isLikelyConversationId(candidateConversationId)) druidRuntime.conversationId = candidateConversationId;
    if (bearer) { druidRuntime.directLineToken = bearer; maybePromoteToGptToken(bearer); }
  }

  if (normalizedUrl.includes("/openai/deployments/")) {
    if (bearer) druidRuntime.gptBearerToken = bearer;
  }
}

function getBearerToken(headers) {
  const authValue = readHeader(headers, "authorization");
  if (!authValue || typeof authValue !== "string") return null;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function readHeader(headers, key) {
  if (!headers) return null;
  const lowerKey = key.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(key) || headers.get(lowerKey);
  if (Array.isArray(headers)) {
    const hit = headers.find((e) => Array.isArray(e) && typeof e[0] === "string" && e[0].toLowerCase() === lowerKey);
    return hit ? hit[1] : null;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof k === "string" && k.toLowerCase() === lowerKey) return typeof v === "string" ? v : null;
    }
  }
  return null;
}

function getAbsoluteUrl(url) {
  try { return new URL(url, window.location.href).toString(); } catch { return null; }
}

function getQueryParam(url, key) {
  try { return new URL(url, window.location.href).searchParams.get(key); } catch { return null; }
}

function isLikelyConversationId(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 10 && trimmed.includes("-") && /^[A-Za-z0-9._|-]+$/.test(trimmed);
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
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const aud      = typeof payload?.aud === "string"                        ? payload.aud.trim()                        : "";
    const llmClaims = typeof payload?.["Druid.LLM.UserClaims"] === "string" ? payload["Druid.LLM.UserClaims"].trim()   : "";
    const iss      = typeof payload?.iss === "string"                        ? payload.iss.trim()                        : "";
    return aud === "Druid.LLM" || !!llmClaims || iss === "Druid AI";
  } catch { return false; }
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  return atob(pad ? normalized + "=".repeat(4 - pad) : normalized);
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
