const OpenAI = require("openai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const apiKey = process.env.GROQ_API_KEY;
let client = null;

if (!apiKey) {
  console.error(
    `CRITICAL ERROR: No GROQ_API_KEY found in ${path.join(__dirname, ".env")}`
  );
} else {
  client = new OpenAI({
    apiKey: apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  console.log("Groq API Key loaded successfully! ✅");
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────
const RATE_LIMIT = 30; // max requests per window
const RATE_WINDOW_MS = 60 * 1000; // 1 minute window
const requestTimestamps = [];

function isRateLimited() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  return requestTimestamps.length >= RATE_LIMIT;
}

function recordRequest() {
  requestTimestamps.push(Date.now());
}

function getWaitTime() {
  if (requestTimestamps.length === 0) return 0;
  const oldest = requestTimestamps[0];
  const waitMs = oldest + RATE_WINDOW_MS - Date.now();
  return Math.max(0, Math.ceil(waitMs / 1000));
}

/**
 * Get a response from the Groq AI tutor.
 *
 * @param {string} userMessage - The user's message
 * @param {Array} history - Conversation history [{role, parts: [{text}]}]
 * @param {Array} files - File attachments (Ignored here, handled by Gemini)
 * @param {string|null} systemInstruction - Optional system instruction
 * @returns {string|null} The AI response text, or null on error
 */
async function getTutorResponse(
  userMessage,
  history = [],
  files = [],
  systemInstruction = null
) {
  try {
    if (!client) {
      console.error("Grok Error: No API client configured (missing API key)");
      return null;
    }

    // Check rate limit before calling API
    if (isRateLimited()) {
      const waitSec = getWaitTime();
      console.warn(`Rate limited! ${RATE_LIMIT} requests used in the last minute. Wait ${waitSec}s.`);
      return `⏳ **Rate limit reached.** You've used ${RATE_LIMIT} AI requests in the last minute. Please wait **${waitSec} seconds** before sending another message.`;
    }

    if (!systemInstruction) {
      systemInstruction = "You are Lumina AI's expert Academic Performance Strategist. Provide clear, concise, and highly actionable guidance.";
    }

    // Build messages array
    const messages = [
      { role: "system", content: systemInstruction },
    ];

    // Add conversation history
    for (const pastMsg of history) {
      if(pastMsg.parts && pastMsg.parts.length > 0) {
          messages.push({
            role: pastMsg.role === "model" ? "assistant" : pastMsg.role,
            content: pastMsg.parts[0].text,
          });
      }
    }

    // Build current message with image support
    if (files && files.length > 0) {
      const contentArray = [{ type: "text", text: userMessage }];
      for (const f of files) {
        if (f.mimeType && f.mimeType.startsWith("image/")) {
           contentArray.push({
             type: "image_url",
             image_url: { url: `data:${f.mimeType};base64,${f.data}` }
           });
        }
      }
      messages.push({ role: "user", content: contentArray });
    } else {
      messages.push({ role: "user", content: userMessage });
    }

    // Record request before calling API
    recordRequest();

    // Updated to stable Groq models. llama-3.2-11b-vision-preview is decommissioned.
    const modelUsed = (files && files.length > 0) ? "llama-3.2-90b-vision-preview" : "llama-3.3-70b-versatile";

    const response = await client.chat.completions.create({
      model: modelUsed,
      messages: messages,
      max_tokens: 4096,
    });

    console.log(`✅ AI response OK (${requestTimestamps.length}/${RATE_LIMIT} requests this minute)`);
    return response.choices[0].message.content;
  } catch (e) {
    console.error(`Grok Error: ${e.message || e}`);
    if (e.status === 429) {
      return "⚠️ **API rate limit reached.** Please wait a moment and try again.";
    }
    if (e.status === 401) {
      return "⚠️ **Invalid API key.** Please check your GROQ_API_KEY in the .env file.";
    }
    return null;
  }
}

/**
 * Generate MCQs from a text or topic description.
 *
 * @param {string} text - The topic or content to generate a quiz from
 * @param {number} count - Number of questions to generate
 * @returns {Array|null} Array of quiz objects or null on error
 */
async function generateQuizFromText(text, count = 5) {
  try {
    if (!client) return null;

    const systemPrompt = `You are an expert AI Exam Generator.
Generate exactly ${count} educational multiple-choice questions based on the provided material.
The material might be a topic description or extracted text from a PDF.
Focus on key concepts, facts, and understanding.

Return ONLY a JSON array of objects with this structure:
[
  {
    "question": "Clear and concise question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_index": 0,
    "explanation": "Brief explanation of why the answer is correct"
  }
]
Do not include any introductory or concluding text. Do not use markdown code blocks.`;

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile", // Updated to Llama 3.3 for latest support
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate a quiz from this content:\n\n${text.substring(0, 30000)}` }, // Limit to 30k chars for safety
      ],
      temperature: 0.6,
    });

    const content = response.choices[0].message.content.trim();
    // Use a regex to extract JSON if the model ignored instructions
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch (e) {
    console.error(`Quiz Generation Error: ${e.message}`);
    return null;
  }
}

/**
 * Generate Flashcards from text.
 *
 * @param {string} text - The topic or content
 * @returns {Array|null} Array of {question, answer} or null on error
 */
async function generateFlashcards(text) {
  try {
    if (!client) return null;

    const systemPrompt = `You are a Student Revision Assistant.
Summarize the main concepts of the provided text into exactly 5-8 flashcards.
Return ONLY a JSON array of objects:
[
  { "question": "string", "answer": "string" }
]
Do not include any intro, outro, or markdown formatting blocks. Just the raw JSON.`;

    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Create flashcards for: ${text}` },
      ],
      temperature: 0.5,
    });

    const content = response.choices[0].message.content.trim();
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch (e) {
    console.error(`Flashcard Generation Error: ${e.message}`);
    return null;
  }
}

/**
 * Get highly specific AI Study Advice based on student's weak topics.
 *
 * @param {Array} topics - Array of {topic_name, score_percentage}
 * @returns {string|null} The advice from Groq
 */
async function getAIStudyAdvice(topics) {
  try {
    if (!client || !topics || topics.length === 0) return null;

    const topicsText = topics
      .map((t) => `${t.topic_name} (Current Score: ${t.score_percentage}%)`)
      .join(", ");

    const systemPrompt = `You are Lumina AI's specialized Academic Performance Advisor.
Analyze the student's performance on these specific topics and provide a short, motivating, and highly actionable study strategy.
Focus on HOW they can improve, not just what is wrong.
Keep the overall advice to 2-4 sentences max.`;

    const userPrompt = `The student is currently struggling with: ${topicsText}. 
Based on these weak areas, what is the best study strategy for them right now?`;

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 512,
    });

    console.log("✅ AI Study Advice generated successfully");
    return response.choices[0].message.content;
  } catch (e) {
    console.error(`AI Advice Error: ${e.message}`);
    return null;
  }
}

module.exports = { getTutorResponse, generateQuizFromText, generateFlashcards, getAIStudyAdvice };
