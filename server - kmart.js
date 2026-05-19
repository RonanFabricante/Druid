const path = require("path");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config({
  path: path.join(__dirname, ".env"),
  override: true
});

const app = express();
const PORT = process.env.PORT || 3000;
const GPT_API_URL =
  process.env.GPT_API_URL ||
  "https://druidservicegateway.comm.eu.druidplatform.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-06-01";
const GPT_BEARER_TOKEN = process.env.GPT_BEARER_TOKEN || "";
const GPT_MODEL = process.env.GPT_MODEL || "gpt-4o-mini";
const DRUID_AUTHORIZE_URL =
  process.env.DRUID_AUTHORIZE_URL ||
  "https://druidapi.comm.eu.druidplatform.com/api/services/app/Chat/AuthorizeAnonymousAsync";
const DIRECTLINE_ACTIVITIES_BASE_URL =
  process.env.DIRECTLINE_ACTIVITIES_BASE_URL ||
  "https://directline.botframework.com/v3/directline/conversations";
const DRUID_CHAT_BEARER_TOKEN = process.env.DRUID_CHAT_BEARER_TOKEN || "";
const TRANSCRIPT_CONTEXT_LINES = Number(process.env.TRANSCRIPT_CONTEXT_LINES || 20);

const druidRuntimeState = {
  authBearerToken: null,
  conversationId: null,
  directLineToken: null,
  gptBearerToken: null,
  lastProcessedActivityId: null,
  lastSeenWatermark: null,
  transcriptConversationId: null,
  transcriptEntries: []
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/extract-fields", async (req, res) => {
  try {
    const { conversation, currentForm } = req.body || {};

    if (!conversation || typeof conversation !== "string") {
      return res.status(400).json({
        error: "conversation is required and must be a string."
      });
    }

    const cleaned = await extractFieldsWithGpt({
      conversation,
      currentForm: currentForm || null
    });

    return res.json({ extracted: cleaned });
  } catch (err) {
    return res.status(500).json({
      error: "Server error during field extraction.",
      details: err.message
    });
  }
});

app.post("/api/test-gpt", async (req, res) => {
  try {
    const prompt = normalizeString(req.body?.prompt) || "Say hello from gpt-4o-mini.";
    const overrideGptBearerToken = normalizeString(req.body?.gptBearerToken);
    const completion = await sendGptChatCompletion({
      overrideGptBearerToken,
      requestBody: {
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "Return valid JSON with keys: status, message."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" }
      }
    });

    const content = completion?.choices?.[0]?.message?.content || null;
    return res.json({
      ok: true,
      endpoint: getStableGptUrl(GPT_API_URL),
      content
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "GPT test failed.",
      details: err.message
    });
  }
});

app.post("/api/test-transcript-gpt", async (req, res) => {
  try {
    const transcript =
      normalizeString(req.body?.transcript) ||
      "user: My name is Alex Johnson\nuser: my email is alex@example.com";
    const currentForm = req.body?.currentForm || null;
    const overrideGptBearerToken = normalizeString(req.body?.gptBearerToken);

    const extracted = await extractFieldsWithGpt({
      conversation: transcript,
      currentForm,
      overrideGptBearerToken
    });

    return res.json({
      ok: true,
      endpoint: getStableGptUrl(GPT_API_URL),
      extracted
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Transcript GPT test failed.",
      details: err.message
    });
  }
});

app.post("/api/autofill-from-druid", async (req, res) => {
  try {
    const { watermark, currentForm, chatBearerToken, directLineToken, conversationId, getStatusUrl } =
      req.body || {};
    const requestedGptBearerToken = normalizeString(req.body?.gptBearerToken);
    const requestedConversationId = normalizeString(conversationId);
    const requestedDirectLineToken = normalizeString(directLineToken);
    const requestedChatBearerToken = normalizeString(chatBearerToken);
    const requestedWatermark = normalizeString(watermark);

    const activitiesPayload = await fetchActivitiesPayload({
      requestedWatermark,
      getStatusUrl: normalizeString(getStatusUrl),
      conversationId: requestedConversationId,
      chatBearerToken: requestedChatBearerToken,
      directLineToken: requestedDirectLineToken
    });

    let activities = extractProcessableActivities(activitiesPayload);
    let effectivePayload = activitiesPayload;

    if (!activities.length) {
      const fallbackPayload = await tryDirectLineFallback({
        conversationId: requestedConversationId || activitiesPayload?.conversationId || null,
        watermark: requestedWatermark,
        directLineToken:
          requestedDirectLineToken || druidRuntimeState.directLineToken || DRUID_CHAT_BEARER_TOKEN
      });
      if (fallbackPayload) {
        const fallbackActivities = extractProcessableActivities(fallbackPayload);
        if (fallbackActivities.length) {
          activities = fallbackActivities;
          effectivePayload = fallbackPayload;
        }
      }
    }

    const updates = [];
    const debug = [];
    let rollingForm = normalizeFormState(currentForm || {});
    const resolvedConversationId =
      effectivePayload?.conversationId || requestedConversationId || druidRuntimeState.conversationId;
    resetTranscriptIfConversationChanged(resolvedConversationId);

    const processableActivities = activities.filter(shouldProcessActivity);
    const payloadWatermark = resolveWatermark(effectivePayload);
    const newActivities = filterNewActivities(processableActivities, payloadWatermark);

    if (processableActivities.length) {
      debug.push({
        stage: "activities_received",
        totalMessageActivities: processableActivities.length
      });
      debug.push({
        stage: "new_activity_detection",
        newActivityCount: newActivities.length,
        watermark: payloadWatermark
      });
      appendTranscriptEntries(processableActivities);

      const anonymousActivities = newActivities.filter(isAnonymousActivity);
      debug.push({
        stage: "anonymous_filter",
        anonymousActivityCount: anonymousActivities.length
      });

      if (anonymousActivities.length) {
        const gptPayload = buildAnonymousPayload(anonymousActivities, TRANSCRIPT_CONTEXT_LINES);
        debug.push({
          stage: "send_to_gpt",
          payloadPreview: gptPayload.slice(0, 300)
        });
        let extracted = null;
        try {
          extracted = await extractFieldsWithGpt({
            conversation: gptPayload,
            currentForm: rollingForm,
            overrideGptBearerToken: requestedGptBearerToken
          });
          const gptTokenMeta = getGptTokenMeta(requestedGptBearerToken);
          debug.push({
            stage: "gpt_response",
            extracted,
            tokenSource: gptTokenMeta.source,
            tokenMasked: gptTokenMeta.masked
          });
        } catch (gptErr) {
          if (/Missing GPT_BEARER_TOKEN/i.test(gptErr?.message || "")) {
            debug.push({
              stage: "gpt_skipped_missing_token",
              message: gptErr.message
            });
            extracted = normalizeFormState({});
          } else {
            throw gptErr;
          }
        }

        const heuristic = heuristicExtractFieldsFromActivities(anonymousActivities, rollingForm);
        const extractedBeforeHeuristic = extracted;
        extracted = mergeFormState(heuristic, extracted);
        if (hasAnyField(heuristic)) {
          debug.push({
            stage: "heuristic_merge_for_missing_fields",
            extractedBeforeHeuristic,
            heuristic,
            extractedAfterHeuristic: extracted
          });
        }

        rollingForm = mergeFormState(rollingForm, extracted);
        if (hasAnyField(extracted)) {
          const lastActivity = anonymousActivities[anonymousActivities.length - 1];
          updates.push({
            activityId: lastActivity?.id || null,
            extracted
          });
        }
      }
    }

    debug.push({
      stage: "frontend_update_payload",
      updatesCount: updates.length
    });

    return res.json({
      updates,
      formState: rollingForm,
      watermark: payloadWatermark,
      conversationId: resolvedConversationId || null,
      debug
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error during DRUID autofill sync.",
      details: err.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// String / field normalizers
// ---------------------------------------------------------------------------

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/@/.test(raw)) return null;

  const candidate = extractNameCandidate(raw) || raw;
  const words = candidate
    .replace(/^[\s"'`.,;:!?-]+|[\s"'`.,;:!?-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.replace(/[^A-Za-z'-]/g, ""))
    .filter(Boolean);

  if (words.length < 2 || words.length > 5) return null;
  if (words.some((w) => w.length < 2)) return null;
  if (words.some((w) => /^(my|name|is|i|am|im|this|call|me|full)$/i.test(w))) return null;

  return words.map(toTitleCase).join(" ");
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (!match?.[0]) return null;
  const trimmed = match[0].trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

function normalizeFormState(form) {
  return {
    name: normalizeName(form?.name),
    email: normalizeEmail(form?.email)
  };
}

function mergeFormState(currentForm, patchForm) {
  return {
    name: patchForm?.name || currentForm?.name || null,
    email: patchForm?.email || currentForm?.email || null
  };
}

function hasAnyField(form) {
  return Boolean(form?.name || form?.email);
}

// ---------------------------------------------------------------------------
// GPT extraction
// ---------------------------------------------------------------------------

async function extractFieldsWithGpt({ conversation, currentForm, overrideGptBearerToken }) {
  const systemPrompt = `
You are a structured information extractor.
From the provided conversation payload, extract ONLY these fields if explicitly or clearly implied:
- name (string — full name, 2–5 words)
- email (string, valid email format if present)

Rules:
1) Return strict JSON object only.
2) If a value is unknown, set it to null.
3) Never invent details.
4) Prioritize explicit user-provided values over bot questions/prompts.
5) If both bot and user messages are present, use user messages as the source of truth.
6) For name, return only the person's name value (2-5 words), never include intent phrases like "my name is", "I am", or extra sentence text.
7) If message says "my name is Alex Johnson", output name as "Alex Johnson" only.
`;

  const userPrompt = JSON.stringify({
    conversation,
    currentForm: currentForm || null,
    expectedOutputShape: {
      name: null,
      email: null
    }
  });

  const requestBody = {
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  if (!/\/deployments\//i.test(GPT_API_URL)) {
    requestBody.model = GPT_MODEL;
  }

  const completion = await sendGptChatCompletion({
    overrideGptBearerToken,
    requestBody
  });
  const raw = completion?.choices?.[0]?.message?.content;
  let extracted = null;
  try {
    extracted = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse GPT response JSON.");
  }

  return normalizeFormState(extracted);
}

// ---------------------------------------------------------------------------
// Heuristic extraction (fallback when GPT token is unavailable)
// ---------------------------------------------------------------------------

function heuristicExtractFieldsFromActivities(activities, currentForm) {
  const merged = normalizeFormState(currentForm || {});
  const userMessages = activities.filter(isUserActivity).map((a) => normalizeString(a.text)).filter(Boolean);

  for (const text of userMessages) {
    if (!merged.email) {
      const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (emailMatch) merged.email = normalizeEmail(emailMatch[0]);
    }

    if (!merged.name && looksLikeName(text)) {
      merged.name = normalizeString(text);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// GPT / token helpers
// ---------------------------------------------------------------------------

function resolveActiveGptBearerToken(overrideGptBearerToken) {
  const normalizedOverride = normalizeString(overrideGptBearerToken);
  if (normalizedOverride) {
    druidRuntimeState.gptBearerToken = overrideGptBearerToken;
  }

  const activeGptBearerToken =
    GPT_BEARER_TOKEN ||
    druidRuntimeState.gptBearerToken ||
    normalizedOverride;

  if (!activeGptBearerToken) {
    throw new Error(
      "Missing GPT_BEARER_TOKEN in environment variables (and no valid runtime gptBearerToken captured)."
    );
  }
  return activeGptBearerToken;
}

function getGptTokenMeta(overrideGptBearerToken) {
  const envToken = normalizeString(GPT_BEARER_TOKEN);
  if (envToken) {
    return { source: "env", masked: maskToken(envToken) };
  }

  const runtimeToken = normalizeString(druidRuntimeState.gptBearerToken);
  if (runtimeToken) {
    return { source: "runtime", masked: maskToken(runtimeToken) };
  }

  const overrideToken = normalizeString(overrideGptBearerToken);
  if (overrideToken) {
    return { source: "request", masked: maskToken(overrideToken) };
  }

  return { source: "none", masked: "(none)" };
}

async function sendGptChatCompletion({ overrideGptBearerToken, requestBody }) {
  const activeGptBearerToken = resolveActiveGptBearerToken(overrideGptBearerToken);
  const stableUrl = getStableGptUrl(GPT_API_URL);
  const openAIResponse = await fetch(stableUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${activeGptBearerToken}`
    },
    body: JSON.stringify(requestBody)
  });

  let finalResponse = openAIResponse;
  if (finalResponse.status === 404 && !/\bapi-version=/i.test(stableUrl)) {
    finalResponse = await fetch(appendApiVersion(stableUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${activeGptBearerToken}`
      },
      body: JSON.stringify(requestBody)
    });
  }

  if (!finalResponse.ok) {
    const errorText = await finalResponse.text();
    throw new Error(`GPT request failed: ${errorText}`);
  }
  return finalResponse.json();
}

// ---------------------------------------------------------------------------
// Druid / DirectLine session management
// ---------------------------------------------------------------------------

async function ensureDruidConversationSession({
  overrideConversationId,
  overrideAuthBearerToken,
  overrideDirectLineToken
}) {
  if (overrideConversationId) druidRuntimeState.conversationId = overrideConversationId;
  if (overrideAuthBearerToken) druidRuntimeState.authBearerToken = overrideAuthBearerToken;
  if (overrideDirectLineToken) druidRuntimeState.directLineToken = overrideDirectLineToken;

  if (druidRuntimeState.conversationId && druidRuntimeState.directLineToken) {
    return druidRuntimeState;
  }

  const authToken = druidRuntimeState.authBearerToken || DRUID_CHAT_BEARER_TOKEN || null;
  const authorizePayload = await callAuthorizeAnonymous(authToken);
  const conversationId =
    findStringByKeys(authorizePayload, ["conversationId"]) ||
    findNestedStringByKeys(authorizePayload, ["result", "conversationId"]);

  if (conversationId) druidRuntimeState.conversationId = conversationId;

  const directLineToken =
    findStringByKeys(authorizePayload, ["token", "directLineToken"]) ||
    findNestedStringByKeys(authorizePayload, ["result", "token"]);

  if (directLineToken) druidRuntimeState.directLineToken = directLineToken;

  if (!druidRuntimeState.conversationId) {
    throw new Error("Could not resolve conversationId from AuthorizeAnonymousAsync response.");
  }
  if (!druidRuntimeState.directLineToken) {
    throw new Error("Could not resolve DirectLine token from AuthorizeAnonymousAsync response.");
  }

  return druidRuntimeState;
}

async function fetchActivitiesPayload({
  requestedWatermark,
  getStatusUrl,
  conversationId,
  chatBearerToken,
  directLineToken
}) {
  const safeConversationId = isLikelyConversationId(conversationId) ? conversationId : null;
  if (getStatusUrl || conversationId) {
    try {
      return await fetchDruidGetStatusActivities({
        getStatusUrl,
        conversationId: safeConversationId,
        watermark: requestedWatermark,
        bearerToken: chatBearerToken || druidRuntimeState.authBearerToken || DRUID_CHAT_BEARER_TOKEN
      });
    } catch (err) {
      // Fall through to directline/authorize fallback if GetStatus path fails.
    }
  }

  const session = await ensureDruidConversationSession({
    overrideConversationId: safeConversationId,
    overrideAuthBearerToken: chatBearerToken,
    overrideDirectLineToken: directLineToken
  });
  const payload = await fetchDirectLineActivities({
    conversationId: session.conversationId,
    bearerToken: session.directLineToken,
    watermark: requestedWatermark
  });
  return { ...payload, conversationId: session.conversationId };
}

async function tryDirectLineFallback({ conversationId, watermark, directLineToken }) {
  if (!isLikelyConversationId(conversationId)) return null;
  if (!directLineToken) return null;

  try {
    const payload = await fetchDirectLineActivities({ conversationId, bearerToken: directLineToken, watermark });
    return { ...payload, conversationId };
  } catch {
    return null;
  }
}

async function fetchDruidGetStatusActivities({ getStatusUrl, conversationId, watermark, bearerToken }) {
  const resolvedConversationId = conversationId || extractConversationIdFromGetStatusUrl(getStatusUrl);
  if (!resolvedConversationId) {
    throw new Error("ConversationId missing for GetStatus call.");
  }

  const url = buildGetStatusUrl({ getStatusUrl, conversationId: resolvedConversationId, watermark });
  const headers = { Accept: "application/json" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  const response = await fetch(url, { method: "GET", headers });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GetStatus fetch failed: ${details}`);
  }

  const payload = await response.json();
  return { ...payload, conversationId: resolvedConversationId };
}

async function callAuthorizeAnonymous(bearerToken) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  let response = await fetch(DRUID_AUTHORIZE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({})
  });

  if (response.status === 404 || response.status === 405) {
    response = await fetch(DRUID_AUTHORIZE_URL, { method: "GET", headers });
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`AuthorizeAnonymousAsync failed: ${details}`);
  }

  return response.json();
}

async function fetchDirectLineActivities({ conversationId, bearerToken, watermark }) {
  let url = `${DIRECTLINE_ACTIVITIES_BASE_URL}/${encodeURIComponent(conversationId)}/activities`;
  if (watermark) url = `${url}?watermark=${encodeURIComponent(watermark)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`DirectLine activities fetch failed: ${details}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Activity processing
// ---------------------------------------------------------------------------

function buildGetStatusUrl({ getStatusUrl, conversationId, watermark }) {
  if (getStatusUrl) {
    const parsed = new URL(getStatusUrl);
    parsed.searchParams.set("ConversationId", conversationId);
    parsed.searchParams.set("Watermark", watermark || "0");
    return parsed.toString();
  }
  const parsed = new URL("https://druidapi.comm.eu.druidplatform.com/GetStatus");
  parsed.searchParams.set("ConversationId", conversationId);
  parsed.searchParams.set("Watermark", watermark || "0");
  return parsed.toString();
}

function extractConversationIdFromGetStatusUrl(getStatusUrl) {
  if (!getStatusUrl) return null;
  try {
    const parsed = new URL(getStatusUrl);
    const cid = parsed.searchParams.get("ConversationId");
    return isLikelyConversationId(cid) ? cid : null;
  } catch {
    return null;
  }
}

function shouldProcessActivity(activity) {
  if (!activity || typeof activity !== "object") return false;
  if (activity.type !== "message") return false;
  return typeof activity.text === "string" && activity.text.trim().length > 0;
}

function extractProcessableActivities(payload) {
  const normalized = [];
  const visited = new Set();

  const directActivities = Array.isArray(payload?.activities) ? payload.activities : [];
  for (const activity of directActivities) {
    const parsed = normalizeActivity(activity);
    if (parsed) normalized.push(parsed);
  }

  // Fallback for tenants where GetStatus does not use "activities" key.
  collectMessageLikeObjects(payload);

  const deduped = [];
  const seen = new Set();
  for (const item of normalized) {
    const key = item.id || `${item?.from?.id || ""}|${normalizeString(item.text)?.toLowerCase() || "(no-text)"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;

  function collectMessageLikeObjects(node) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) collectMessageLikeObjects(entry);
      return;
    }

    const parsed = normalizeActivity(node);
    if (parsed) normalized.push(parsed);

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") collectMessageLikeObjects(value);
    }
  }
}

function normalizeActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text =
    normalizeString(raw.text) ||
    normalizeString(raw.message) ||
    normalizeString(raw.content) ||
    normalizeString(raw.prompt);
  if (!text) return null;

  const type = normalizeString(raw.type) || "message";
  if (type !== "message") return null;

  const fromRaw = raw.from && typeof raw.from === "object" ? raw.from : {};
  const role = normalizeString(fromRaw.role) || inferRole(raw, fromRaw);
  const from = {
    id: normalizeString(fromRaw.id) || normalizeString(raw.senderId) || null,
    name: normalizeString(fromRaw.name) || normalizeString(raw.senderName) || null,
    role
  };

  return {
    id: normalizeString(raw.id) || normalizeString(raw.messageId) || null,
    type: "message",
    text,
    from,
    conversation:
      raw.conversation && typeof raw.conversation === "object"
        ? { id: normalizeString(raw.conversation.id) || null }
        : { id: null },
    textFormat: normalizeString(raw.textFormat) || null,
    locale: normalizeString(raw.locale) || null,
    attachments: [],
    entities: Array.isArray(raw.entities) ? raw.entities : []
  };
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

function appendTranscriptEntries(activities) {
  const knownIds = new Set(druidRuntimeState.transcriptEntries.map((entry) => entry.id));
  for (const activity of activities) {
    const text = normalizeString(activity?.text);
    if (!text) continue;
    const id = normalizeString(activity?.id) || `${Date.now()}-${Math.random()}`;
    if (knownIds.has(id)) continue;
    druidRuntimeState.transcriptEntries.push({
      id,
      line: `${getSpeakerLabel(activity)}: ${text}`
    });
    knownIds.add(id);
  }

  const maxStored = Math.max(TRANSCRIPT_CONTEXT_LINES * 5, 50);
  if (druidRuntimeState.transcriptEntries.length > maxStored) {
    druidRuntimeState.transcriptEntries = druidRuntimeState.transcriptEntries.slice(-maxStored);
  }
}

function getTranscriptContextChunk(lineLimit) {
  const safeLimit = Number.isFinite(lineLimit) && lineLimit > 0 ? Math.floor(lineLimit) : 20;
  return druidRuntimeState.transcriptEntries
    .slice(-safeLimit)
    .map((entry) => entry.line)
    .join("\n");
}

function resetTranscriptIfConversationChanged(conversationId) {
  const normalized = normalizeString(conversationId);
  if (!normalized) return;
  if (druidRuntimeState.transcriptConversationId === normalized) return;
  druidRuntimeState.transcriptConversationId = normalized;
  druidRuntimeState.transcriptEntries = [];
  druidRuntimeState.lastProcessedActivityId = null;
  druidRuntimeState.lastSeenWatermark = null;
}

function buildAnonymousPayload(currentActivities, contextLineLimit) {
  const recentLines = getTranscriptContextChunk(contextLineLimit)
    .split("\n")
    .filter(Boolean);

  const anonymousMessages = currentActivities.map((activity) => ({
    from: {
      id: normalizeString(activity?.from?.id),
      name: normalizeString(activity?.from?.name)
    },
    conversation: {
      id: normalizeString(activity?.conversation?.id)
    },
    textFormat: normalizeString(activity?.textFormat) || "plain",
    locale: normalizeString(activity?.locale),
    text: normalizeString(activity?.text),
    entities: Array.isArray(activity?.entities) ? activity.entities : []
  }));

  return JSON.stringify(
    {
      instructions:
        "Extract profile fields from anonymous user messages only. Ignore bot prompts and confirmations.",
      recentContextLines: recentLines,
      anonymousMessages
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Utility / shared helpers
// ---------------------------------------------------------------------------

function filterNewActivities(activities, watermark) {
  if (!Array.isArray(activities) || !activities.length) return [];

  const normalizedWatermark = normalizeString(watermark);
  if (
    normalizedWatermark &&
    druidRuntimeState.lastSeenWatermark &&
    normalizedWatermark === druidRuntimeState.lastSeenWatermark
  ) {
    return [];
  }

  let startIndex = 0;
  const lastProcessedId = normalizeString(druidRuntimeState.lastProcessedActivityId);
  if (lastProcessedId) {
    const foundAt = activities.findIndex((a) => normalizeString(a?.id) === lastProcessedId);
    if (foundAt >= 0) startIndex = foundAt + 1;
  }

  const fresh = activities.slice(startIndex);
  const lastFresh = fresh[fresh.length - 1];
  if (lastFresh?.id) {
    druidRuntimeState.lastProcessedActivityId = normalizeString(lastFresh.id);
  }
  if (normalizedWatermark) {
    druidRuntimeState.lastSeenWatermark = normalizedWatermark;
  }
  return fresh;
}

function isAnonymousActivity(activity) {
  const id = (normalizeString(activity?.from?.id) || "").toLowerCase();
  const name = (normalizeString(activity?.from?.name) || "").toLowerCase();
  return id === "anonymous" || name === "anonymous";
}

function isUserActivity(activity) {
  const from = activity?.from || {};
  const role = normalizeString(from.role);
  const id = (normalizeString(from.id) || "").toLowerCase();
  const name = (normalizeString(from.name) || "").toLowerCase();
  return role === "user" || id === "anonymous" || name === "anonymous";
}

function getSpeakerLabel(activity) {
  const from = activity?.from || {};
  const role = normalizeString(from.role);
  const name = normalizeString(from.name);
  const id = normalizeString(from.id);

  if (role === "user") return "user";
  if (name) return `bot(${name})`;
  if (id && id !== "anonymous") return `bot(${id})`;
  return "user";
}

function inferRole(raw, fromRaw) {
  const roleCandidate =
    normalizeString(raw.role) || normalizeString(raw.senderRole) || normalizeString(raw.authorRole);
  if (roleCandidate === "user" || roleCandidate === "bot") return roleCandidate;

  const fromId = normalizeString(fromRaw.id) || "";
  if (fromId.toLowerCase() === "anonymous") return "user";
  if (fromId) return "bot";
  return "user";
}

function resolveWatermark(payload) {
  return (
    normalizeString(payload?.watermark) ||
    normalizeString(payload?.waterMark) ||
    normalizeString(payload?.Watermark) ||
    normalizeString(payload?.WaterMark) ||
    null
  );
}

function isLikelyConversationId(value) {
  const trimmed = normalizeString(value);
  if (!trimmed) return false;
  if (trimmed.length < 10) return false;
  if (!trimmed.includes("-")) return false;
  return /^[A-Za-z0-9._|-]+$/.test(trimmed);
}

function isLikelyLlmToken(token) {
  const trimmed = normalizeString(token);
  if (!trimmed) return false;

  const parts = trimmed.split(".");
  if (parts.length < 2) return false;

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    const aud = normalizeString(payload?.aud);
    const issuer = normalizeString(payload?.iss);
    const llmClaims = normalizeString(payload?.["Druid.LLM.UserClaims"]);

    return aud === "Druid.LLM" || Boolean(llmClaims) || issuer === "Druid AI";
  } catch {
    return false;
  }
}

function maskToken(token) {
  const value = normalizeString(token);
  if (!value) return "(none)";
  if (value.length < 14) return "********";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function parseJsonObjectSafe(raw) {
  const normalized = normalizeString(raw);
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch {
    const match = normalized.match(/\{[\s\S]*\}/);
    if (!match?.[0]) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function getStableGptUrl(url) {
  const fallback =
    "https://druidservicegateway.comm.eu.druidplatform.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-06-01";
  const value = normalizeString(url) || fallback;
  return /\bapi-version=/i.test(value) ? value : appendApiVersion(value);
}

function appendApiVersion(url) {
  if (/\bapi-version=/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}api-version=2024-06-01`;
}

function findStringByKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  const queue = [obj];
  const visited = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    for (const key of keys) {
      if (typeof node[key] === "string" && node[key].trim()) {
        return node[key].trim();
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

function findNestedStringByKeys(obj, keys) {
  let cursor = obj;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = cursor[key];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : null;
}

function toTitleCase(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function extractNameCandidate(text) {
  const patterns = [
    /(?:my\s+(?:full\s+)?name\s+is|name\s+is|i\s+am|i[' ]?m|this\s+is|call\s+me)\s+([^,.!?;:\n]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function looksLikeName(text) {
  return Boolean(normalizeName(text));
}
