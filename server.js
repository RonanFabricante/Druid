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
// Aged care "About Me" assessment — personality trait options
const PERSONALITY_TRAIT_OPTIONS = [
  "affectionate", "anxious", "caring", "confident", "content",
  "creative", "curious", "determined", "dependable", "easy-going",
  "friendly", "funny", "generous", "good listener", "happy",
  "hard working", "homebody", "intelligent", "insecure", "kind",
  "loving", "a nurturer", "outgoing", "outspoken", "passionate",
  "perceptive", "perfectionist", "popular", "proud", "fun-loving"
];

// Worry type options
const WORRY_TYPE_OPTIONS = [
  "my own health",
  "the health of loved ones",
  "finances",
  "feeling lonely",
  "family issues",
  "relationships in my life",
  "other"
];

// Coping strategy options
const COPING_STRATEGY_OPTIONS = [
  "look on the bright side",
  "spend time with people i am close to",
  "spend time alone",
  "my faith/spiritual beliefs helps me",
  "i try to keep busy",
  "i like to work on solutions to things",
  "i distract myself with",
  "other"
];

// Support person actions options
const SUPPORT_PERSON_ACTIONS_OPTIONS = [
  "puts my favourite music on",
  "sits and talks with me",
  "prays with me",
  "looks through photographs with me",
  "holds or hugs me",
  "makes me laugh",
  "gives me a hand massage",
  "brings me my favourite",
  "other"
];

// Third-person variants the bot/user say → canonical first-person checkbox value.
// The bot asks "what does that person do?" using "them/they" language; user answers similarly.
const SUPPORT_PERSON_ACTIONS_ALIASES = {
  "puts their favourite music on":       "puts my favourite music on",
  "puts his favourite music on":         "puts my favourite music on",
  "puts her favourite music on":         "puts my favourite music on",
  "sits and talks with them":            "sits and talks with me",
  "sits and talks with him":             "sits and talks with me",
  "sits and talks with her":             "sits and talks with me",
  "prays with them":                     "prays with me",
  "prays with him":                      "prays with me",
  "prays with her":                      "prays with me",
  "looks through photographs with them": "looks through photographs with me",
  "looks through photographs with him":  "looks through photographs with me",
  "looks through photographs with her":  "looks through photographs with me",
  "holds or hugs them":                  "holds or hugs me",
  "holds or hugs him":                   "holds or hugs me",
  "holds or hugs her":                   "holds or hugs me",
  "makes them laugh":                    "makes me laugh",
  "makes him laugh":                     "makes me laugh",
  "makes her laugh":                     "makes me laugh",
  "gives them a hand massage":           "gives me a hand massage",
  "gives him a hand massage":            "gives me a hand massage",
  "gives her a hand massage":            "gives me a hand massage",
  "brings them their favourite":         "brings me my favourite",
  "brings him his favourite":            "brings me my favourite",
  "brings her her favourite":            "brings me my favourite",
};

const druidRuntimeState = {
  authBearerToken: null,
  conversationId: null,
  directLineToken: null,
  gptBearerToken: null,
  lastProcessedActivityId: null,
  lastSeenWatermark: null,
  transcriptConversationId: null,
  transcriptEntries: [],
  imageOcrByActivityId: {},
  imageOcrKeys: [],
  lastImageOcrResult: null
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
    const uploadedImages = [];
    let imageExtraction = null;
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
      uploadedImages.push(...extractUploadedImagesFromActivities(newActivities));

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

    if (!uploadedImages.length && processableActivities.length) {
      const historicalImages = extractUploadedImagesFromActivities(processableActivities);
      const latestHistoricalImage = historicalImages[historicalImages.length - 1] || null;
      if (latestHistoricalImage) {
        uploadedImages.push(latestHistoricalImage);
        debug.push({
          stage: "historical_image_fallback",
          activityId: latestHistoricalImage.activityId || null
        });
      }
    }

    if (uploadedImages.length) {
      const latestImage = uploadedImages[uploadedImages.length - 1];
      imageExtraction = await resolveImageExtraction({
        latestImage,
        overrideGptBearerToken: requestedGptBearerToken,
        debug
      });
      if (imageExtraction?.name && !rollingForm.name) {
        rollingForm = mergeFormState(rollingForm, { name: imageExtraction.name });
      }
    }

    debug.push({
      stage: "frontend_update_payload",
      updatesCount: updates.length,
      uploadedImageCount: uploadedImages.length,
      imageOcr: imageExtraction
        ? {
            activityId: imageExtraction.activityId || null,
            hasName: Boolean(imageExtraction.name),
            hasPassportId: Boolean(imageExtraction.passportId),
            source: imageExtraction.source || "none"
          }
        : null
    });

    return res.json({
      updates,
      uploadedImages,
      imageExtraction: imageExtraction || druidRuntimeState.lastImageOcrResult || null,
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

function isLikelyConversationId(value) {
  const trimmed = normalizeString(value);
  if (!trimmed) return false;
  if (trimmed.length < 10) return false;
  if (!trimmed.includes("-")) return false;
  return /^[A-Za-z0-9._|-]+$/.test(trimmed);
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (!match?.[0]) return null;
  const trimmed = match[0].trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    const [, dd, mm, yyyy] = ddMmYyyy;
    return `${yyyy}-${mm}-${dd}`;
  }

  const ddSlashMmSlashYyyy = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddSlashMmSlashYyyy) {
    const [, dd, mm, yyyy] = ddSlashMmSlashYyyy;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function normalizeGender(value) {
  const allowed = new Set(["male", "female", "non-binary", "prefer-not-to-say"]);
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function normalizeRelationshipStatus(value) {
  const allowed = new Set([
    "single",
    "married",
    "in-a-relationship",
    "divorced",
    "widowed",
    "prefer-not-to-say"
  ]);
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function normalizeWorkArrangement(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;

  const candidates = buildWorkArrangementCandidates();

  const direct = candidates.find((candidate) => candidate.keys.has(raw));
  if (direct) return direct.value;

  const normalized = normalizeLookupText(raw);
  if (!normalized) return null;

  const normalizedDirect = candidates.find((candidate) => candidate.keys.has(normalized));
  if (normalizedDirect) return normalizedDirect.value;

  const ordinalIndex = parseOrdinalOptionIndex(normalized);
  if (ordinalIndex !== null && candidates[ordinalIndex]) {
    return candidates[ordinalIndex].value;
  }

  for (const candidate of candidates) {
    for (const key of candidate.keys) {
      if (key.length >= 4 && normalized.includes(key)) {
        return candidate.value;
      }
    }
  }

  return null;
}

function buildWorkArrangementCandidates() {
  return WORK_ARRANGEMENT_OPTIONS.map((option) => {
    const keys = new Set();
    const addKey = (input) => {
      const normalized = normalizeLookupText(input);
      if (normalized) keys.add(normalized);
    };

    addKey(option.value);
    for (const alias of option.aliases || []) addKey(alias);

    return {
      value: option.value,
      keys
    };
  });
}

function parseOrdinalOptionIndex(normalizedText) {
  const match = normalizedText.match(
    /\b(1|one|first|1st|2|two|second|2nd|3|three|third|3rd|4|four|fourth|4th|5|five|fifth|5th|6|six|sixth|6th)\b/
  );
  if (!match?.[1]) return null;
  if (!/\b(option|arrangement|choice)\b/.test(normalizedText) && !/\bgo with\b/.test(normalizedText)) {
    return null;
  }

  const token = match[1];
  const indexMap = {
    "1": 0,
    one: 0,
    first: 0,
    "1st": 0,
    "2": 1,
    two: 1,
    second: 1,
    "2nd": 1,
    "3": 2,
    three: 2,
    third: 2,
    "3rd": 2,
    "4": 3,
    four: 3,
    fourth: 3,
    "4th": 3,
    "5": 4,
    five: 4,
    fifth: 4,
    "5th": 4,
    "6": 5,
    six: 5,
    sixth: 5,
    "6th": 5
  };

  return Object.prototype.hasOwnProperty.call(indexMap, token) ? indexMap[token] : null;
}

function normalizeLookupText(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function normalizePassportId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{4,20}$/.test(compact)) return null;
  return compact.toUpperCase();
}

function normalizeImageOcrFields(payload) {
  return {
    name: normalizeName(payload?.name),
    passportId: normalizePassportId(payload?.passportId)
  };
}

function normalizeStringArray(value, allowedOptions, aliasMap) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(allowedOptions.map((s) => s.toLowerCase()));
  return value
    .map((v) => {
      if (typeof v !== "string") return null;
      const lower = v.trim().toLowerCase();
      // Resolve alias if provided (e.g. third-person → first-person)
      const resolved = (aliasMap && aliasMap[lower]) ? aliasMap[lower].toLowerCase() : lower;
      return allowed.has(resolved) ? resolved : null;
    })
    .filter(Boolean);
}

function normalizeFormState(form) {
  return {
    // Section: About Me — resident identity
    firstName: normalizeString(form?.firstName) || null,
    lastName: normalizeString(form?.lastName) || null,
    dateOfBirth: normalizeDate(form?.dateOfBirth) || null,
    facility: normalizeString(form?.facility) || null,
    wrb: normalizeString(form?.wrb) || null,

    // Section: Personality traits (array of selected strings)
    personalityTraits: normalizeStringArray(form?.personalityTraits, PERSONALITY_TRAIT_OPTIONS),

    // Section: Life history / important things
    importantThingsRightNow: normalizeString(form?.importantThingsRightNow) || null,
    favouriteSongOrMusic: normalizeString(form?.favouriteSongOrMusic) || null,

    // Section: Worries and Coping
    worryTypes: normalizeStringArray(form?.worryTypes, WORRY_TYPE_OPTIONS),
    worriedOrUpsetDetails: normalizeString(form?.worriedOrUpsetDetails) || null,
    copingStrategies: normalizeStringArray(form?.copingStrategies, COPING_STRATEGY_OPTIONS),
    copingDistractWith: normalizeString(form?.copingDistractWith) || null,
    copingOther: normalizeString(form?.copingOther) || null,

    // Section: Support person
    supportPersonActions: normalizeStringArray(form?.supportPersonActions, SUPPORT_PERSON_ACTIONS_OPTIONS, SUPPORT_PERSON_ACTIONS_ALIASES),
    supportPersonActionsOther: normalizeString(form?.supportPersonActionsOther) || null
  };
}

function mergeStringArrays(patchArr, currentArr) {
  const base = Array.isArray(currentArr) ? currentArr : [];
  const patch = Array.isArray(patchArr) ? patchArr : [];
  if (!patch.length) return base;
  // Union: keep all from base, add new from patch
  const merged = [...base];
  for (const item of patch) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged;
}

function mergeFormState(currentForm, patchForm) {
  return {
    firstName: patchForm?.firstName || currentForm?.firstName || null,
    lastName: patchForm?.lastName || currentForm?.lastName || null,
    dateOfBirth: patchForm?.dateOfBirth || currentForm?.dateOfBirth || null,
    facility: patchForm?.facility || currentForm?.facility || null,
    wrb: patchForm?.wrb || currentForm?.wrb || null,
    personalityTraits: mergeStringArrays(patchForm?.personalityTraits, currentForm?.personalityTraits),
    importantThingsRightNow: patchForm?.importantThingsRightNow || currentForm?.importantThingsRightNow || null,
    favouriteSongOrMusic: patchForm?.favouriteSongOrMusic || currentForm?.favouriteSongOrMusic || null,
    worryTypes: mergeStringArrays(patchForm?.worryTypes, currentForm?.worryTypes),
    worriedOrUpsetDetails: patchForm?.worriedOrUpsetDetails || currentForm?.worriedOrUpsetDetails || null,
    copingStrategies: mergeStringArrays(patchForm?.copingStrategies, currentForm?.copingStrategies),
    copingDistractWith: patchForm?.copingDistractWith || currentForm?.copingDistractWith || null,
    copingOther: patchForm?.copingOther || currentForm?.copingOther || null,
    supportPersonActions: mergeStringArrays(patchForm?.supportPersonActions, currentForm?.supportPersonActions),
    supportPersonActionsOther: patchForm?.supportPersonActionsOther || currentForm?.supportPersonActionsOther || null
  };
}

function hasAnyField(form) {
  return Boolean(
    form?.firstName ||
      form?.lastName ||
      form?.dateOfBirth ||
      form?.facility ||
      form?.wrb ||
      (Array.isArray(form?.personalityTraits) && form.personalityTraits.length) ||
      form?.importantThingsRightNow ||
      form?.favouriteSongOrMusic ||
      (Array.isArray(form?.worryTypes) && form.worryTypes.length) ||
      form?.worriedOrUpsetDetails ||
      (Array.isArray(form?.copingStrategies) && form.copingStrategies.length) ||
      form?.copingDistractWith ||
      form?.copingOther ||
      (Array.isArray(form?.supportPersonActions) && form.supportPersonActions.length) ||
      form?.supportPersonActionsOther
  );
}

async function extractFieldsWithGpt({ conversation, currentForm, overrideGptBearerToken }) {
  const systemPrompt = `
You are a structured information extractor for an aged care facility's resident "About Me" assessment form.
From the provided conversation payload, extract ONLY these fields if explicitly or clearly stated:

Resident identity:
- firstName (string)
- lastName (string)
- dateOfBirth (string in YYYY-MM-DD format)
- facility (string — name of the aged care facility)
- wrb (string — wing/room/bed identifier, e.g. "Wing/11/11")

Personality traits (array of strings — select only from allowed values):
- personalityTraits: array containing zero or more of: "affectionate", "anxious", "caring", "confident", "content",
  "creative", "curious", "determined", "dependable", "easy-going", "friendly", "funny", "generous",
  "good listener", "happy", "hard working", "homebody", "intelligent", "insecure", "kind",
  "loving", "a nurturer", "outgoing", "outspoken", "passionate", "perceptive", "perfectionist",
  "popular", "proud", "fun-loving"

Life history (the family member describes the resident in third person — e.g. "My father loves his family", "She enjoys classical music"):
- importantThingsRightNow (string — extract the FULL user answer after the bot asks about most important things in the resident's life right now; bot question contains phrases like "most important things", "life right now", "family, friends, faith". Store the user's complete answer verbatim.)
- favouriteSongOrMusic (string — extract the FULL user answer after the bot asks about favourite song or music; bot question contains phrases like "favourite song", "type of music", "music they love". Store the user's complete answer verbatim.)

Worries and Coping:
- worryTypes (array of strings from: "my own health", "the health of loved ones", "finances",
  "feeling lonely", "family issues", "relationships in my life", "other")
- worriedOrUpsetDetails (string — extract the FULL user answer after the bot asks if the resident is worried or upset about anything right now; bot question contains "worried or upset about anything", "particularly worried". Store verbatim.)
- copingStrategies (array of strings from: "look on the bright side", "spend time with people i am close to",
  "spend time alone", "my faith/spiritual beliefs helps me", "i try to keep busy",
  "i like to work on solutions to things", "i distract myself with", "other")
- copingDistractWith (string — what they distract themselves with, if mentioned)
- copingOther (string — other coping strategy free text, if mentioned)

Support person:
- supportPersonActions (array of strings — the family member or bot may use third-person phrasing like "sits and talks with them" or first-person like "sits and talks with me"; always return the FIRST-PERSON canonical value from this list:
  "puts my favourite music on", "sits and talks with me", "prays with me",
  "looks through photographs with me", "holds or hugs me", "makes me laugh",
  "gives me a hand massage", "brings me my favourite", "other")
- supportPersonActionsOther (string — other support person action free text, if mentioned)

CONVERSATION CONTEXT:
This is a conversation between a chatbot (bot) and a FAMILY MEMBER (user, labelled "user:" in the transcript). The family member is filling in a profile for their PARENT (the resident). The resident does not speak.

The transcript is an ordered list of lines like:
  bot: What are the most important things to Jose in his life right now? ...
  user: My father loves his family and his daily walk.
  bot: Does Jose have a favourite song or type of music they love?
  user: He loves Frank Sinatra.

To extract a field: find the bot question that matches the field description, then take the VERY NEXT user line as the value.

CONCRETE EXAMPLES:
- bot asks about "most important things" → next user line → importantThingsRightNow = that full user text
- bot asks about "favourite song" or "music" → next user line → favouriteSongOrMusic = that full user text
- bot asks "worried or upset about anything" → next user line → worriedOrUpsetDetails = that full user text

Rules:
1) Return strict JSON object only — no markdown, no extra keys.
2) If a value is unknown or not mentioned, set scalars to null and arrays to [].
3) Never invent or infer details that are not clearly stated.
4) Normalize dateOfBirth to YYYY-MM-DD format when possible.
5) For array fields, only include values from the allowed lists above (lowercased, exact match).
6) For free-text fields (importantThingsRightNow, favouriteSongOrMusic, worriedOrUpsetDetails), copy the user's answer VERBATIM — do not summarise or paraphrase.
7) CRITICAL — firstName and lastName are the RESIDENT's name only:
   - firstName must come from user reply after bot asks "What's your dad's/mum's/parent's first name?"
   - lastName must come from user reply after bot asks "[Name]'s last name?"
   - FORBIDDEN name values: "their", "son", "daughter", "mum", "dad", "I'm", "I am", "their son", "their daughter" and any relationship phrase.
   - When in doubt, return null.
`;

  // `conversation` arrives as a pre-built JSON string from buildAnonymousPayload/buildTranscriptPayload.
  // Parse it first so we don't double-encode it when wrapping in userPrompt.
  let conversationObj;
  try {
    conversationObj = typeof conversation === "string" ? JSON.parse(conversation) : conversation;
  } catch {
    conversationObj = { raw: conversation };
  }

  const userPrompt = JSON.stringify({
    conversation: conversationObj,
    currentForm: currentForm || null,
    expectedOutputShape: {
      firstName: null,
      lastName: null,
      dateOfBirth: null,
      facility: null,
      wrb: null,
      personalityTraits: [],
      importantThingsRightNow: null,
      favouriteSongOrMusic: null,
      worryTypes: [],
      worriedOrUpsetDetails: null,
      copingStrategies: [],
      copingDistractWith: null,
      copingOther: null,
      supportPersonActions: [],
      supportPersonActionsOther: null
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

async function extractPassportFieldsFromImageWithGpt({ imageUrl, overrideGptBearerToken }) {
  if (!normalizeString(GPT_BEARER_TOKEN)) {
    throw new Error("Missing GPT_BEARER_TOKEN in .env for OCR.");
  }
  if (!normalizeString(GPT_API_URL)) {
    throw new Error("Missing GPT_API_URL in .env for OCR.");
  }

  const systemPrompt = `
You are an OCR extractor for identity documents.
Read the provided image and extract:
- name (full person name as text)
- passportId (passport number/id as text)

Rules:
1) Return strict JSON object only.
2) If field is not visible or uncertain, return null for that field.
3) Do not invent values.
4) Keep passportId exactly as seen (letters/numbers/symbols), trimmed.
`;

  const requestBody = {
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract name and passportId from this ID image." },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ]
  };

  if (!/\/deployments\//i.test(GPT_API_URL)) {
    requestBody.model = GPT_MODEL;
  }

  try {
    const completion = await sendGptChatCompletion({
      overrideGptBearerToken,
      requestBody
    });
    const raw = completion?.choices?.[0]?.message?.content;
    const parsed = parseJsonObjectSafe(raw);
    if (!parsed) throw new Error("Failed to parse image OCR GPT response JSON.");
    return normalizeImageOcrFields(parsed);
  } catch (primaryErr) {
    const fallbackRequestBody = {
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Return JSON only with keys name and passportId." },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ]
    };
    if (!/\/deployments\//i.test(GPT_API_URL)) {
      fallbackRequestBody.model = GPT_MODEL;
    }

    const fallbackCompletion = await sendGptChatCompletion({
      overrideGptBearerToken,
      requestBody: fallbackRequestBody
    });
    const fallbackRaw = fallbackCompletion?.choices?.[0]?.message?.content;
    const fallbackParsed = parseJsonObjectSafe(fallbackRaw);
    if (!fallbackParsed) {
      throw new Error(`Image OCR parse failed. Primary error: ${primaryErr?.message || "unknown"}`);
    }
    return normalizeImageOcrFields(fallbackParsed);
  }
}

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

async function ensureDruidConversationSession({
  overrideConversationId,
  overrideAuthBearerToken,
  overrideDirectLineToken
}) {
  if (overrideConversationId) {
    druidRuntimeState.conversationId = overrideConversationId;
  }
  if (overrideAuthBearerToken) {
    druidRuntimeState.authBearerToken = overrideAuthBearerToken;
  }
  if (overrideDirectLineToken) {
    druidRuntimeState.directLineToken = overrideDirectLineToken;
  }

  if (druidRuntimeState.conversationId && druidRuntimeState.directLineToken) {
    return druidRuntimeState;
  }

  const authToken = druidRuntimeState.authBearerToken || DRUID_CHAT_BEARER_TOKEN || null;
  const authorizePayload = await callAuthorizeAnonymous(authToken);
  const conversationId =
    findStringByKeys(authorizePayload, ["conversationId"]) ||
    findNestedStringByKeys(authorizePayload, ["result", "conversationId"]);

  if (conversationId) {
    druidRuntimeState.conversationId = conversationId;
  }

  const directLineToken =
    findStringByKeys(authorizePayload, ["token", "directLineToken"]) ||
    findNestedStringByKeys(authorizePayload, ["result", "token"]);

  if (directLineToken) {
    druidRuntimeState.directLineToken = directLineToken;
  }

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
  return {
    ...payload,
    conversationId: session.conversationId
  };
}

async function tryDirectLineFallback({ conversationId, watermark, directLineToken }) {
  if (!isLikelyConversationId(conversationId)) return null;
  if (!directLineToken) return null;

  try {
    const payload = await fetchDirectLineActivities({
      conversationId,
      bearerToken: directLineToken,
      watermark
    });
    return {
      ...payload,
      conversationId
    };
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
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GetStatus fetch failed: ${details}`);
  }

  const payload = await response.json();
  return {
    ...payload,
    conversationId: resolvedConversationId
  };
}

async function callAuthorizeAnonymous(bearerToken) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  let response = await fetch(DRUID_AUTHORIZE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({})
  });

  if (response.status === 404 || response.status === 405) {
    response = await fetch(DRUID_AUTHORIZE_URL, {
      method: "GET",
      headers
    });
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`AuthorizeAnonymousAsync failed: ${details}`);
  }

  return response.json();
}

async function fetchDirectLineActivities({ conversationId, bearerToken, watermark }) {
  let url = `${DIRECTLINE_ACTIVITIES_BASE_URL}/${encodeURIComponent(conversationId)}/activities`;
  if (watermark) {
    url = `${url}?watermark=${encodeURIComponent(watermark)}`;
  }

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
  if (typeof activity.text === "string" && activity.text.trim().length > 0) return true;
  return hasImageAttachment(activity.attachments);
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
      if (value && typeof value === "object") {
        collectMessageLikeObjects(value);
      }
    }
  }
}

function normalizeActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const attachments = getActivityAttachments(raw);
  const text =
    normalizeString(raw.text) ||
    normalizeString(raw.message) ||
    normalizeString(raw.content) ||
    normalizeString(raw.prompt);
  if (!text && !hasImageAttachment(attachments)) return null;

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
    attachments,
    entities: Array.isArray(raw.entities) ? raw.entities : []
  };
}

function hasImageAttachment(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return false;
  return attachments.some((attachment) => {
    const contentType = normalizeString(attachment?.contentType);
    if (contentType && /^image\//i.test(contentType)) return true;
    const candidate =
      normalizeString(attachment?.thumbnailUrl) ||
      normalizeString(attachment?.contentUrl) ||
      normalizeString(attachment?.content);
    return candidate ? /^data:image\//i.test(candidate) : false;
  });
}

function getActivityAttachments(raw) {
  if (!raw || typeof raw !== "object") return [];
  const candidates = [];

  collect(raw.attachments);
  collect(raw.Attachments);
  collect(raw.attachment);
  collect(raw.Attachment);

  if (raw.channelData && typeof raw.channelData === "object") {
    collect(raw.channelData.attachments);
    collect(raw.channelData.Attachment);
    collect(raw.channelData.attachment);
  }
  if (raw.value && typeof raw.value === "object") {
    collect(raw.value.attachments);
    collect(raw.value.Attachment);
    collect(raw.value.attachment);
  }

  return candidates;

  function collect(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") candidates.push(item);
      }
      return;
    }
    if (typeof value === "object") {
      candidates.push(value);
    }
  }
}

function extractImageFromActivity(activity) {
  if (!Array.isArray(activity?.attachments)) return null;
  for (const attachment of activity.attachments) {
    const candidate =
      normalizeString(attachment?.thumbnailUrl) ||
      normalizeString(attachment?.contentUrl) ||
      normalizeString(attachment?.content);
    if (!candidate) continue;

    const derivedType = getImageContentType({
      declaredContentType: normalizeString(attachment?.contentType),
      data: candidate
    });
    if (!derivedType) continue;

    const dataUrl = coerceToImageDataUrl(candidate, derivedType);
    if (!dataUrl) continue;

    return {
      contentType: derivedType,
      dataUrl,
      name: normalizeString(attachment?.name)
    };
  }
  return null;
}

function extractUploadedImagesFromActivities(activities) {
  if (!Array.isArray(activities) || !activities.length) return [];
  const images = [];
  const seenKeys = new Set();

  for (const activity of activities) {
    const image = extractImageFromActivity(activity);
    if (!image) continue;
    const activityId = normalizeString(activity?.id);
    const dedupeKey = activityId || image.dataUrl;
    if (!dedupeKey || seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    images.push({
      activityId: activityId || null,
      contentType: image.contentType,
      dataUrl: image.dataUrl,
      name: image.name || null
    });
  }

  return images;
}

async function resolveImageExtraction({ latestImage, overrideGptBearerToken, debug }) {
  const activityId = normalizeString(latestImage?.activityId) || null;
  const imageUrl = normalizeString(latestImage?.dataUrl);
  if (!imageUrl) return null;

  const cacheKey = activityId || `image:${imageUrl.slice(0, 128)}`;
  const cached = druidRuntimeState.imageOcrByActivityId[cacheKey];
  if (cached) {
    const result = { ...cached, source: "cache" };
    druidRuntimeState.lastImageOcrResult = result;
    return result;
  }

  try {
    const extracted = await extractPassportFieldsFromImageWithGpt({
      imageUrl,
      overrideGptBearerToken: null
    });
    const normalized = {
      activityId,
      name: extracted?.name || null,
      passportId: extracted?.passportId || null,
      source: "gpt-4o-mini"
    };
    rememberImageOcrResult(cacheKey, normalized);
    druidRuntimeState.lastImageOcrResult = normalized;
    return normalized;
  } catch (err) {
    console.error("[Image OCR] failed", {
      activityId,
      message: err?.message || "Unknown OCR error"
    });
    debug.push({
      stage: "image_ocr_failed",
      activityId,
      message: err?.message || "Unknown OCR error"
    });
    return null;
  }
}

function rememberImageOcrResult(cacheKey, result) {
  if (!cacheKey) return;
  druidRuntimeState.imageOcrByActivityId[cacheKey] = result;
  druidRuntimeState.imageOcrKeys.push(cacheKey);
  if (druidRuntimeState.imageOcrKeys.length > 200) {
    const stale = druidRuntimeState.imageOcrKeys.shift();
    if (stale) delete druidRuntimeState.imageOcrByActivityId[stale];
  }
}

function coerceToImageDataUrl(value, contentType) {
  if (/^data:image\//i.test(value)) return value;
  if (/^https?:\/\/\S+/i.test(value)) return value;
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, "").length > 32) {
    const compact = value.replace(/\s+/g, "");
    return `data:${contentType};base64,${compact}`;
  }
  return null;
}

function getImageContentType({ declaredContentType, data }) {
  if (declaredContentType && /^image\//i.test(declaredContentType)) {
    return declaredContentType;
  }
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/i.exec(data);
  if (dataUrlMatch?.[1]) return dataUrlMatch[1];
  return null;
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

function isAnonymousActivity(activity) {
  const id = (normalizeString(activity?.from?.id) || "").toLowerCase();
  const name = (normalizeString(activity?.from?.name) || "").toLowerCase();
  return id === "anonymous" || name === "anonymous";
}

function heuristicExtractFieldsFromActivities(activities, currentForm) {
  const merged = normalizeFormState(currentForm || {});
  const userMessages = activities.filter(isUserActivity).map((a) => normalizeString(a.text)).filter(Boolean);
  const allText = userMessages.join(" ").toLowerCase();

  // Extract date of birth
  if (!merged.dateOfBirth) {
    for (const text of userMessages) {
      const dateMatch =
        text.match(/\b\d{4}-\d{2}-\d{2}\b/) ||
        text.match(/\b\d{2}-\d{2}-\d{4}\b/) ||
        text.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
      if (dateMatch) {
        merged.dateOfBirth = normalizeDate(dateMatch[0]);
        break;
      }
    }
  }

  // Extract first/last name from messages that look like a name
  if (!merged.firstName) {
    for (const text of userMessages) {
      const normalized = normalizeName(text);
      if (normalized) {
        const parts = normalized.split(" ");
        merged.firstName = parts[0] || null;
        merged.lastName = parts.slice(1).join(" ") || null;
        break;
      }
    }
  }

  // ── Free-text fields: scan the full transcript for bot-question → user-answer pairs ──
  // Use the stored transcript entries (which include both bot and user lines) for context.
  const transcriptLines = druidRuntimeState.transcriptEntries.map((e) => e.line);

  if (!merged.importantThingsRightNow || !merged.favouriteSongOrMusic || !merged.worriedOrUpsetDetails) {
    for (let i = 1; i < transcriptLines.length; i++) {
      const line = transcriptLines[i];
      // Only look at user lines
      if (!line.startsWith("user:")) continue;
      const userText = line.replace(/^user:\s*/i, "").trim();
      if (!userText) continue;

      // Scan back through preceding lines for the most recent bot question
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prevLine = transcriptLines[j].toLowerCase();
        if (!prevLine.startsWith("bot") && !prevLine.startsWith("kai")) continue;

        if (!merged.importantThingsRightNow &&
            (prevLine.includes("most important things") ||
             prevLine.includes("life right now") ||
             prevLine.includes("family, friends, faith") ||
             prevLine.includes("sentimental objects"))) {
          merged.importantThingsRightNow = userText;
          break;
        }

        if (!merged.favouriteSongOrMusic &&
            (prevLine.includes("favourite song") ||
             prevLine.includes("favorite song") ||
             prevLine.includes("piece of music") ||
             prevLine.includes("music they love") ||
             prevLine.includes("type of music"))) {
          merged.favouriteSongOrMusic = userText;
          break;
        }

        if (!merged.worriedOrUpsetDetails &&
            (prevLine.includes("worried or upset about anything") ||
             prevLine.includes("particularly worried") ||
             prevLine.includes("worried or upset about right now"))) {
          merged.worriedOrUpsetDetails = userText;
          break;
        }
      }
    }
  }

  // Heuristic: personality traits mentioned
  for (const trait of PERSONALITY_TRAIT_OPTIONS) {
    const pattern = new RegExp("\\b" + trait.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (pattern.test(allText) && !merged.personalityTraits.includes(trait)) {
      merged.personalityTraits.push(trait);
    }
  }

  // Heuristic: worry types
  for (const worry of WORRY_TYPE_OPTIONS) {
    const pattern = new RegExp("\\b" + worry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (pattern.test(allText) && !merged.worryTypes.includes(worry)) {
      merged.worryTypes.push(worry);
    }
  }

  // Heuristic: coping strategies
  for (const strategy of COPING_STRATEGY_OPTIONS) {
    const pattern = new RegExp("\\b" + strategy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (pattern.test(allText) && !merged.copingStrategies.includes(strategy)) {
      merged.copingStrategies.push(strategy);
    }
  }

  // Heuristic: support person actions — match both first-person (checkbox values) and
  // third-person variants (how the bot asks / user answers)
  const allSupportCandidates = [
    ...SUPPORT_PERSON_ACTIONS_OPTIONS,
    ...Object.keys(SUPPORT_PERSON_ACTIONS_ALIASES)
  ];
  for (const candidate of allSupportCandidates) {
    const canonical = SUPPORT_PERSON_ACTIONS_ALIASES[candidate] || candidate;
    if (merged.supportPersonActions.includes(canonical)) continue;
    const pattern = new RegExp("\\b" + candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (pattern.test(allText)) {
      merged.supportPersonActions.push(canonical);
    }
  }

  return merged;
}

function isUserActivity(activity) {
  const from = activity?.from || {};
  const role = normalizeString(from.role);
  const id = (normalizeString(from.id) || "").toLowerCase();
  const name = (normalizeString(from.name) || "").toLowerCase();
  return role === "user" || id === "anonymous" || name === "anonymous";
}

function looksLikeName(text) {
  return Boolean(normalizeName(text));
}

function buildTranscriptChunk(activities) {
  const lines = [];
  for (const activity of activities) {
    const speaker = getSpeakerLabel(activity);
    const text = normalizeString(activity?.text) || "";
    lines.push(`${speaker}: ${text}`);
  }
  return lines.join("\n");
}

function buildTranscriptPayload(currentActivities, contextLineLimit) {
  const recentLines = getTranscriptContextChunk(contextLineLimit)
    .split("\n")
    .filter(Boolean);

  const recentSet = new Set(recentLines);
  for (const activity of currentActivities) {
    const text = normalizeString(activity?.text);
    if (!text) continue;
    const label = getSpeakerLabel(activity);
    const line = `${label}: ${text}`;
    if (!recentSet.has(line)) {
      recentLines.push(line);
      recentSet.add(line);
    }
  }

  return JSON.stringify(
    {
      instructions:
        "Extract resident profile fields from this conversation transcript. " +
        "Match each user answer to the bot question immediately before it to determine the field. " +
        "CONTEXT: The user is a family member describing their parent (the resident) to the bot. " +
        "For free-text fields, capture the user's full answer verbatim. " +
        "Never extract firstName/lastName from relationship statements like 'I'm their son'.",
      transcript: recentLines
    },
    null,
    2
  );
}

function buildAnonymousPayload(currentActivities, contextLineLimit) {
  // Build a unified sequential transcript: recent context lines + current new activities merged in order.
  // This lets GPT clearly see bot-question → user-answer pairs rather than two separate structures.
  const recentLines = getTranscriptContextChunk(contextLineLimit)
    .split("\n")
    .filter(Boolean);

  // Append the current batch if not already in recentLines (dedup by content)
  const recentSet = new Set(recentLines);
  for (const activity of currentActivities) {
    const text = normalizeString(activity?.text);
    if (!text) continue;
    const label = isUserActivity(activity) ? "user" : `bot`;
    const line = `${label}: ${text}`;
    if (!recentSet.has(line)) {
      recentLines.push(line);
      recentSet.add(line);
    }
  }

  return JSON.stringify(
    {
      instructions:
        "You are extracting resident profile fields from a conversation transcript. " +
        "The transcript contains alternating bot questions and user answers. " +
        "CONTEXT: The USER is a family member (son/daughter) describing their PARENT (the resident) to the bot. " +
        "Match each user answer to the bot question immediately preceding it to determine which field it belongs to. " +
        "For free-text fields like importantThingsRightNow and favouriteSongOrMusic: " +
        "the user answers in third person (e.g. 'My father loves his family', 'He likes classical music') — " +
        "capture the full answer text exactly as given. " +
        "Never extract firstName/lastName from relationship statements like 'I am their son'.",
      transcript: recentLines
    },
    null,
    2
  );
}

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

  // Keep a larger buffer for dedupe; context window is applied separately.
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
  druidRuntimeState.imageOcrByActivityId = {};
  druidRuntimeState.imageOcrKeys = [];
  druidRuntimeState.lastImageOcrResult = null;
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

    return (
      aud === "Druid.LLM" ||
      Boolean(llmClaims) ||
      issuer === "Druid AI"
    );
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