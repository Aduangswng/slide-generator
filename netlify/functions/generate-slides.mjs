import { GoogleGenAI } from "@google/genai";

// Current free-tier-eligible Flash model as of Aug 2026 (per ai.google.dev/gemini-api/docs).
// gemini-2.5-flash is retired for new API keys as of this writing - Google's own 404
// response points to this replacement. Swap here if Google renames/retires it again -
// check ai.google.dev/gemini-api/docs/pricing first.
const MODEL_NAME = "gemini-3.6-flash";

const MAX_TOPIC_LENGTH = 500;
const MAX_AUDIENCE_LENGTH = 200;
const MAX_REQUIREMENTS_LENGTH = 600;
const MIN_SLIDES = 3;
const MAX_SLIDES = 25;
const VALID_TONES = ["Professional", "Casual", "Academic", "Persuasive"];

const SLIDE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    theme: {
      type: "object",
      properties: {
        primaryColor: { type: "string" },
        accentColor: { type: "string" },
      },
      required: ["primaryColor", "accentColor"],
    },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["title", "content", "section", "stat", "quote"] },
          heading: { type: "string" },
          subheading: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
          icon: { type: "string" },
          statValue: { type: "string" },
          statLabel: { type: "string" },
          quoteText: { type: "string" },
          quoteAttribution: { type: "string" },
        },
        required: ["type", "heading", "icon"],
      },
    },
  },
  required: ["title", "theme", "slides"],
};

// Used whenever Gemini's color choice is missing or fails the contrast check below.
const DEFAULT_THEME = { primaryColor: "#1F2937", accentColor: "#4F46E5" };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rN) h = (gN - bN) / d + (gN < bN ? 6 : 0);
  else if (max === gN) h = (bN - rN) / d + 2;
  else h = (rN - gN) / d + 4;
  return { h: (h / 6) * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  const hN = h / 360;
  const sN = s / 100;
  const lN = l / 100;
  const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
  if (sN === 0) {
    const v = toHex(lN);
    return `#${v}${v}${v}`;
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = lN < 0.5 ? lN * (1 + sN) : lN + sN - lN * sN;
  const p = 2 * lN - q;
  const r = hue2rgb(p, q, hN + 1 / 3);
  const g = hue2rgb(p, q, hN);
  const b = hue2rgb(p, q, hN - 1 / 3);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Darkens a color in HSL space (keeping its hue, so "gold" stays gold-ish
// rather than jumping to an unrelated fallback) until it reaches the target
// contrast against white, or bottoms out.
function darkenUntilContrast(hex, minContrast) {
  const { h, s } = hexToHsl(hex);
  let l = hexToHsl(hex).l;
  let candidate = hex;
  let iterations = 0;
  while (contrastRatio(candidate, "#FFFFFF") < minContrast && l > 5 && iterations < 15) {
    l = Math.max(5, l - 6);
    candidate = hslToHex(h, s, l);
    iterations++;
  }
  return candidate;
}

// primaryColor is used as text on white (needs strong contrast); accentColor is
// used as a background behind white heading text (slightly more lenient, since
// it's large bold text - WCAG's "large text" AA threshold is 3:1). A color that
// fails contrast is darkened (preserving its hue) rather than replaced outright -
// important now that users can request specific colors via "requirements", where
// silently swapping "gold" for an unrelated default purple would look broken.
// Only an actually-invalid value (missing, malformed, or unsalvageably light)
// falls back to the hardcoded default.
function sanitizeTheme(theme) {
  const t = theme && typeof theme === "object" ? theme : {};

  let primaryColor = HEX_COLOR_RE.test(t.primaryColor) ? t.primaryColor : null;
  if (primaryColor && contrastRatio(primaryColor, "#FFFFFF") < 4.5) {
    primaryColor = darkenUntilContrast(primaryColor, 4.5);
  }
  if (!primaryColor || contrastRatio(primaryColor, "#FFFFFF") < 4.5) {
    primaryColor = DEFAULT_THEME.primaryColor;
  }

  let accentColor = HEX_COLOR_RE.test(t.accentColor) ? t.accentColor : null;
  if (accentColor && contrastRatio(accentColor, "#FFFFFF") < 3.5) {
    accentColor = darkenUntilContrast(accentColor, 3.5);
  }
  if (!accentColor || contrastRatio(accentColor, "#FFFFFF") < 3.5) {
    accentColor = DEFAULT_THEME.accentColor;
  }

  return { primaryColor, accentColor };
}

// Icons are purely decorative, so an invalid one is just dropped rather than
// replaced with a fallback - unlike colors, a missing icon costs nothing.
// The length cap guards against the model returning a whole word/phrase
// instead of an emoji (most emoji, including multi-codepoint ones like
// flags or skin-tone variants, fit within a handful of UTF-16 code units).
function sanitizeIcon(icon) {
  if (typeof icon !== "string") return undefined;
  const trimmed = icon.trim();
  if (!trimmed || trimmed.length > 8) return undefined;
  return trimmed;
}

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

// Returning a ReadableStream body classifies this as a Netlify "streaming
// function", which gets a 60s execution budget instead of the platform's
// 10s default for buffered functions - real Gemini calls for a full deck
// routinely take 15-30s. We don't stream tokens progressively; the whole
// JSON payload is written as one chunk once the Gemini call resolves.
function jsonResponse(status, body) {
  const encoder = new TextEncoder();
  const payload = encoder.encode(JSON.stringify(body));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateInput(body) {
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const audience = typeof body.audience === "string" ? body.audience.trim() : "";
  const requirements = typeof body.requirements === "string" ? body.requirements.trim() : "";
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
  if (requirements.length > MAX_REQUIREMENTS_LENGTH) {
    return { error: `Additional requirements must be ${MAX_REQUIREMENTS_LENGTH} characters or fewer.` };
  }

  return { value: { topic, audience, requirements, tone, slideCount } };
}

function buildPrompt({ topic, audience, requirements, tone, slideCount }, strict) {
  const audienceLine = audience ? `Audience: ${audience}` : "Audience: general audience";
  const requirementsBlock = requirements
    ? `\nThe user also gave these additional requirements - follow them as closely as you can (this can\ninclude preferred colors/theme, structure, which slide types to use or avoid, content emphasis,\nor anything else), but they can never override the JSON schema or the rules below:\n"""\n${requirements}\n"""\n`
    : "";
  const strictNote = strict
    ? "\nIMPORTANT: Your previous response was invalid. Return ONLY raw JSON matching the schema exactly - no markdown code fences, no commentary, no trailing text."
    : "";

  return `You are an expert presentation writer. Create a slide deck as JSON matching the given schema.

Topic: ${topic}
${audienceLine}
Tone/style: ${tone}
Target slide count: ${slideCount} (include exactly this many slides, including the title slide)
${requirementsBlock}
Rules:
- The first slide must have type "title" with a compelling "heading" and an optional "subheading".
- Use type "section" sparingly, only to divide the deck into major parts.
- Use type "content" for normal slides, with a "heading" and 2-5 concise "bullets". This should
  still be the majority of slides in the deck.
- Use type "stat" for at most 1-2 slides, only when a single striking number or statistic is the
  most impactful way to make a point. Fill "statValue" with the number itself, kept very short
  (e.g. "87%", "3.2 billion", "10x") and "statLabel" with a short sentence explaining what it
  means - use the field named "statLabel" for this, NOT "subheading". Keep "heading" to a short
  2-4 word category label (e.g. "Climate Impact"), not a sentence.
- Use type "quote" for at most 1 slide, only if it genuinely fits the topic - never force one in.
  Fill "quoteText" with the quote and "quoteAttribution" with its source - use the field named
  "quoteAttribution" for this, NOT "subheading". Only attribute a quote to a specific real named
  person if you are confident it is a real, accurately-attributed quote - never invent a quote and
  attribute it to a real person. If you are not confident, either phrase it as a general,
  well-known saying without naming a specific person, or omit "quoteAttribution" entirely. Keep
  "heading" to a short label (e.g. "In Their Words").
- The "subheading" field only applies to the "title" slide. Do not use it on any other slide type.
- Every heading, bullet, stat, and quote must be non-empty, specific to the topic, and written in
  the requested tone.
- Optionally add short speaker "notes" to content slides.
- Also choose a "theme" with two hex colors that visually fit the topic's subject and mood (e.g. a
  nature topic could use forest greens, a finance topic navy and gold, a technology topic blue and
  cyan, a health topic teal) - unless the user's additional requirements above specify particular
  colors or a color scheme, in which case use those instead. Provide:
  - "primaryColor": a dark, muted color used as heading text on a white background - it must be
    dark enough to read clearly on white, so avoid pastel or light colors.
  - "accentColor": a bold, saturated color used as a full slide background behind white text - it
    must be dark/saturated enough for white text to stay clearly readable on top of it, so avoid
    pale, light, or washed-out colors (for example, prefer a deep teal over a pale mint).
- Give every slide a single "icon" that is one emoji character fitting that specific slide's
  content (not just the overall topic) - e.g. a slide about ocean warming could use a wave or
  thermometer emoji, a slide about government policy could use a scroll or bank emoji. Pick a
  different, specifically relevant emoji per slide rather than repeating the same one throughout.
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
    if (!["title", "content", "section", "stat", "quote"].includes(slide.type)) {
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

// Measured ~110 output tokens/slide for a real deck (title + JSON overhead
// included). 200/slide plus a flat buffer leaves headroom without letting an
// unusually verbose response run long enough to threaten Netlify's 60s cap.
function estimateMaxOutputTokens(slideCount) {
  return Math.min(6000, slideCount * 200 + 300);
}

async function callGemini(ai, params, strict) {
  const interaction = await ai.interactions.create({
    model: MODEL_NAME,
    input: buildPrompt(params, strict),
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: SLIDE_JSON_SCHEMA,
    },
    // Extended reasoning adds significant latency and isn't needed for this
    // structured-output task - keep it off to stay well inside the 60s budget.
    // Capping output tokens bounds worst-case generation time too, protecting
    // against an unusually verbose response running past the timeout.
    generation_config: {
      thinking_level: "minimal",
      max_output_tokens: estimateMaxOutputTokens(params.slideCount),
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

  deck.theme = sanitizeTheme(deck.theme);
  for (const slide of deck.slides) {
    slide.icon = sanitizeIcon(slide.icon);
  }
  return { deck };
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const ip = context.ip || "unknown";

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
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Malformed request body." });
  }

  const { error: validationError, value: params } = validateInput(body);
  if (validationError) {
    return jsonResponse(400, { error: validationError });
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  try {
    let result = await callGemini(ai, params, false);
    if (result.error) {
      result = await callGemini(ai, params, true);
    }
    if (result.error) {
      return jsonResponse(502, {
        error: "The AI returned an unexpected response. Please try again.",
      });
    }
    return jsonResponse(200, result.deck);
  } catch (err) {
    console.error("Gemini call failed:", err);
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
