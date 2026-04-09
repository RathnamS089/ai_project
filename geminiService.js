const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const apiKey = process.env.GEMINI_API_KEY;
let genAI = null;

if (!apiKey) {
  console.error(
    `CRITICAL ERROR: No GEMINI_API_KEY found in ${path.join(__dirname, ".env")}`
  );
} else {
  genAI = new GoogleGenerativeAI(apiKey);
  console.log("Gemini API Key loaded successfully! ✅");
}

/**
 * Get a response from Google Gemini AI.
 *
 * @param {string} userMessage - The user's message
 * @param {Array} history - Conversation history [{role, parts: [{text}]}]
 * @param {Array} files - File attachments [{mimeType, data (base64)}]
 * @param {string|null} systemInstruction - Optional system instruction
 * @returns {string|null} The AI response text, or null on error
 */
async function getGeminiResponse(
  userMessage,
  history = [],
  files = [],
  systemInstruction = null
) {
  try {
    if (!genAI) {
      console.error("Gemini Error: No API client configured (missing API key)");
      return null;
    }

    // Default system instruction if none provided
    const finalSystemInstruction = systemInstruction ||
      "You are Lumina AI's expert Academic Strategist. Provide insightful feedback and clear analysis of study materials.";

    // Initialize model
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction: finalSystemInstruction
    });

    // Prepare message parts (text + files)
    const contentParts = [{ text: userMessage }];

    // Add files as inlineData
    for (const f of files) {
      if (f.data && f.mimeType) {
        contentParts.push({
          inlineData: {
            mimeType: f.mimeType,
            data: f.data
          }
        });
      }
    }

    // Format history for Gemini
    // Note: Gemini expects 'user' and 'model' roles. 
    // History parts must be an array of {text: string}
    const geminiHistory = history.map(h => ({
      role: h.role === "model" ? "model" : "user",
      parts: [{ text: h.parts[0].text }]
    }));

    // Start chat with history
    const chatSession = model.startChat({
      history: geminiHistory,
      generationConfig: {
        maxOutputTokens: 4096,
      },
    });

    // Send message with text and files
    console.log(`🚀 Sending ${files.length} files to Gemini for analysis...`);
    const result = await chatSession.sendMessage(contentParts);
    const response = await result.response;
    const text = response.text();

    console.log("✅ Gemini response OK");
    return text;

  } catch (e) {
    console.error(`Gemini Error: ${e.message || e}`);
    return `⚠️ **Gemini Service Error:** ${e.message || "Unknown error"}`;
  }
}

module.exports = { getGeminiResponse };
