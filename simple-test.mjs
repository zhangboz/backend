import 'dotenv/config';
import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });

async function imageUnderstand() {
  const myfile = await ai.files.upload({
    file: "C:/Users/zb683/OneDrive/Pictures/Screenshots/Screenshot 2024-07-28 122139.png",
    config: { mimeType: "image/jpeg" },
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: createUserContent([
      createPartFromUri(myfile.uri, myfile.mimeType),
      "What is this image about? Use a few words to describe it.",
    ]),
  });
  console.log(response.text);
}


await imageUnderstand();


