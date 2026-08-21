const { GoogleGenAI } = require("@google/genai");

// Current free-tier-eligible Flash model as of Aug 2026 (per ai.google.dev/gemini-api/docs).
// Swap this if Google renames/retires it - check ai.google.dev/gemini-api/docs/pricing first.
const MODEL_NAME = "gemini-2.5-flash";

const MAX_TOPIC_LENGTH = 500;
const MAX_AUDIENCE_LENGTH = 200;
const MIN_SLIDES = 3;
const MAX_SLIDES = 25;
const VALID_TONES = ["Professional", "Casual", "Academic", "Persuasive"];

const SLIDE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["title", "content", "section"] },
          heading: { type: "string" },
          subheading: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["type", "heading"],
      },
    },
  },
  required: ["title", "slides"],
};

// Simple in-memory per-IP throttle. Resets whenever the function's container
// recycles - good enough for MVP abuse protection, no external store needed.
const lastRequestByIp = new Map();
const MIN_MS_BETWEEN_REQUESTS = 8000;

function checkRateLimit(ip) {
  const now = Date.now();
  const last = lastRequestByIp.get(ip);
  if (last && now - last < MIN_MS_BETWEEN_REQUESTS) {
    return false;
  }
  lastRequestByIp.set(ip, now);
  // Keep the map from growing unbounded over the container's lifetime.
  if (lastRequestByIp.size > 500) {
    const cutoff = now - MIN_MS_BETWEEN_REQUESTS;
    for (const [key, ts] of lastRequestByIp) {
      if (ts < cutoff) lastRequestByIp.delete(key);
    }
  }
  return true;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function validateInput(body) {
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const audience = typeof body.audience === "string" ? body.audience.trim() : "";
  const tone = VALID_TONES.includes(body.tone) ? body.tone : "Professional";
  let slideCount = Number.parseInt(body.slideCount, 10);
  if (!Number.isFinite(slideCount)) slideCount = 8;
  slideCount = Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, slideCount));

  if (!topic) {
    return { error: "Please describe what your presentation is about." };
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    return { error: `Topic must be ${MAX_TOPIC_LENGTH} characters or fewer.` };
  }
  if (audience.length > MAX_AUDIENCE_LENGTH) {
    return { error: `Audience must be ${MAX_AUDIENCE_LENGTH} characters or fewer.` };
  }

  return { value: { topic, audience, tone, slideCount } };
}

function buildPrompt({ topic, audience, tone, slideCount }, strict) {
  const audienceLine = audience ? `Audience: ${audience}` : "Audience: general audience";
  const strictNote = strict
    ? "\nIMPORTANT: Your previous response was invalid. Return ONLY raw JSON matching the schema exactly - no markdown code fences, no commentary, no trailing text."
    : "";

  return `You are an expert presentation writer. Create a slide deck as JSON matching the given schema.

Topic: ${topic}
${audienceLine}
Tone/style: ${tone}
Target slide count: ${slideCount} (include exactly this many slides, including the title slide)

Rules:
- The first slide must have type "title" with a compelling "heading" and an optional "subheading".
- Use type "section" sparingly, only to divide the deck into major parts.
- Use type "content" for normal slides, with a "heading" and 2-5 concise "bullets".
- Every heading and bullet must be non-empty, specific to the topic, and written in the requested tone.
- Optionally add short speaker "notes" to content slides.
- Return ONLY valid JSON matching the schema. No markdown fences, no explanations.${strictNote}`;
}

function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

function validateDeckShape(deck, expectedSlideCount) {
  if (!deck || typeof deck !== "object") return "Response was not a JSON object.";
  if (typeof deck.title !== "string" || !deck.title.trim()) return "Missing deck title.";
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) return "Missing slides array.";

  for (const [i, slide] of deck.slides.entries()) {
    if (!slide || typeof slide !== "object") return `Slide ${i + 1} is not an object.`;
    if (!["title", "content", "section"].includes(slide.type)) {
      return `Slide ${i + 1} has an invalid type.`;
    }
    if (typeof slide.heading !== "string" || !slide.heading.trim()) {
      return `Slide ${i + 1} is missing a heading.`;
    }
    if (slide.bullets && !Array.isArray(slide.bullets)) {
      return `Slide ${i + 1} has invalid bullets.`;
    }
  }

  const diff = Math.abs(deck.slides.length - expectedSlideCount);
  if (diff > Math.max(3, expectedSlideCount * 0.5)) {
    return `Slide count (${deck.slides.length}) is too far from the requested ${expectedSlideCount}.`;
  }

  return null;
}

async function callGemini(ai, input, params, strict) {
  const interaction = await ai.interactions.create({
    model: MODEL_NAME,
    input: buildPrompt(params, strict),
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: SLIDE_JSON_SCHEMA,
    },
  });

  const raw = stripCodeFences(interaction.output_text || "");
  let deck;
  try {
    deck = JSON.parse(raw);
  } catch {
    return { error: "AI response was not valid JSON." };
  }

  const shapeError = validateDeckShape(deck, params.slideCount);
  if (shapeError) {
    return { error: shapeError };
  }

  return { deck };
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    context.clientContext?.ip ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return jsonResponse(429, {
      error: "You're generating decks a bit fast - please wait a few seconds and try again.",
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return jsonResponse(500, {
      error: "Server is missing its Gemini API key. Set GEMINI_API_KEY in Netlify environment variables.",
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Malformed request body." });
  }

  const { error: validationError, value: params } = validateInput(body);
  if (validationError) {
    return jsonResponse(400, { error: validationError });
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  try {
    let result = await callGemini(ai, body, params, false);
    if (result.error) {
      result = await callGemini(ai, body, params, true);
    }
    if (result.error) {
      return jsonResponse(502, {
        error: "The AI returned an unexpected response. Please try again.",
      });
    }
    return jsonResponse(200, result.deck);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (/quota|rate.?limit|429/i.test(message)) {
      return jsonResponse(429, {
        error: "The AI service is temporarily out of free quota. Please try again in a bit.",
      });
    }
    return jsonResponse(502, {
      error: "Could not reach the AI service. Please check your connection and try again.",
    });
  }
};
