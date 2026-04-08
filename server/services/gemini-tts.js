/**
 * Gemini native TTS (preview) — oplæsning til admin voice-bot.
 * @see https://ai.google.dev/gemini-api/docs/speech-generation
 */

const logger = require("../lib/logger");
const { collectGeminiApiKeys } = require("../lib/gemini");

const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Achird";
const SAMPLE_RATE = 24000;

function pcm16MonoToWav(pcm) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = pcm.length;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(numChannels, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  pcm.copy(out, 44);
  return out;
}

function clipForTts(text, maxChars) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > maxChars * 0.7 ? cut.slice(0, lastSpace) : cut;
  return base + " …";
}

/**
 * @param {string} text
 * @returns {Promise<Buffer>} WAV (PCM16 mono 24 kHz)
 */
async function synthesizeGeminiTtsToWav(text) {
  const keys = collectGeminiApiKeys();
  if (!keys.length) {
    const err = new Error("GEMINI_API_KEY mangler");
    err.code = "NO_KEY";
    throw err;
  }

  const model = process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;
  const voiceName = process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE;
  const maxChars = Math.min(Number(process.env.GEMINI_TTS_MAX_CHARS) || 4500, 8000);
  const toSpeak = clipForTts(text, maxChars);

  const prompt = [
    "Du er voice-assistent for en admin-shop.",
    "Læs følgende ordret op på flydende dansk: klar udtale, rolig professionel tone, naturlig tempo.",
    "Læs kun teksten — ingen intro, ingen \"her er\", eller kommentarer.",
    "Tekst:",
    toSpeak,
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  let lastErr = null;
  for (let i = 0; i < keys.length; i += 1) {
    const apiKey = keys[i];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.error?.message || `Gemini TTS HTTP ${r.status}`;
        const err = new Error(msg);
        err.status = r.status;
        lastErr = err;
        const tryNext = [401, 403, 429, 500, 502, 503].includes(Number(r.status)) && i < keys.length - 1;
        if (tryNext) {
          logger.warn("gemini.tts_fallback_key", { fromKeyIndex: i + 1, status: r.status });
          continue;
        }
        throw err;
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      let b64 = null;
      for (const p of parts) {
        b64 = p?.inlineData?.data ?? p?.inline_data?.data ?? null;
        if (b64) break;
      }
      if (!b64) {
        const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback;
        throw new Error("Gemini TTS returnerede intet lyd — " + JSON.stringify(reason || {}).slice(0, 200));
      }

      const pcm = Buffer.from(b64, "base64");
      return pcm16MonoToWav(pcm);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const net =
        /fetch failed|econnreset|etimedout|enotfound|network|timed out/i.test(msg) && i < keys.length - 1;
      if (net) {
        logger.warn("gemini.tts_fallback_key", { fromKeyIndex: i + 1, reason: "network" });
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("Gemini TTS failed");
}

module.exports = {
  synthesizeGeminiTtsToWav,
  pcm16MonoToWav,
  SAMPLE_RATE,
};
