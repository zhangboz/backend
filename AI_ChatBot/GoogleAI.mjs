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
      "这个图片在说什么？简单介绍一下这个图片的内容。如果是一道题目，给出答案和分析。如果图片里有太多信息，如超过三道题，可以回复“题目太多，请分开提问”。",
    ]),
  });
  return response.text;
}

export { imageUnderstand };