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
    model: "gemini-2.0-flash",
    //model: "gemini-2.5-pro-exp-03-25",
    contents: createUserContent([
      createPartFromUri(myfile.uri, myfile.mimeType),
      "回答图片中的问题，给出答案和分析，输出Markdown+LaTeX格式，我会自己编译成可阅读的文档。记得用中文，不要说礼貌性用语（例如“好的”，“这是答案”），直接给出答案就好。如果图片并非学校题目，拒绝回答。",
    ]),
  });
  console.log("Response from Gemini:");
  console.log(response.usageMetadata);
  return response.text;
}

export { imageUnderstand };