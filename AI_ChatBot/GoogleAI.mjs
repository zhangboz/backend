import 'dotenv/config';
import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });

// Refactored: Accept file path and mimeType as arguments
async function imageUnderstand(filePath, mimeType) {
  const myfile = await ai.files.upload({
    file: filePath,
    config: { mimeType: mimeType },
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro-exp-03-25",
    contents: createUserContent([
      createPartFromUri(myfile.uri, myfile.mimeType),
      "What is this image about? Use a few words to describe it.",
    ]),
  });
  return response.text;
}

export { imageUnderstand };