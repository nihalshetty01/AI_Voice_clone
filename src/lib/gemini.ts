import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error('Missing GEMINI_API_KEY in environment variables.');
}

const genAI = new GoogleGenerativeAI(apiKey);

// Helper to transcribe audio using Gemini's native multimodal capabilities
export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

  console.log(`[*] Sending audio to Gemini for transcription (${mimeType})...`);
  const response = await model.generateContent([
    {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: mimeType,
      },
    },
    {
      text: 'Transcribe the spoken audio query accurately in English or Hinglish. Do not translate. Output ONLY the transcription, with no preamble or extra text.',
    },
  ]);

  const text = response.response.text().trim();
  console.log(`[+] Transcribed query: "${text}"`);
  return text;
}

interface GroundedResponse {
  text: string;
  sources: string;
}

// Helper to query Gemini with search grounding and Nihal's system style rules
export async function generateGroundedReply(
  query: string,
  systemInstruction: string
): Promise<GroundedResponse> {
  const modelName = 'gemini-3.5-flash';

  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      tools: [{ googleSearch: {} } as any],
    });

    console.log(`[*] Generating reply with search grounding for query: "${query}"...`);
    
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: query }] }],
      systemInstruction: systemInstruction,
    });

    const text = response.response.text().trim();
    
    // Extract search grounding sources if available
    let sources = '';
    const candidate = response.response.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata;

    if (groundingMetadata && groundingMetadata.groundingChunks) {
      const chunks = groundingMetadata.groundingChunks;
      const links: string[] = [];

      for (const chunk of chunks) {
        if (chunk.web && chunk.web.uri && chunk.web.title) {
          links.push(`[${chunk.web.title}](${chunk.web.uri})`);
        }
      }

      if (links.length > 0) {
        // De-duplicate sources
        sources = Array.from(new Set(links)).join('\n');
      }
    }

    console.log(`[+] Reply generated with search grounding. Found ${sources ? sources.split('\n').length : 0} sources.`);
    return { text, sources };

  } catch (error: any) {
    console.warn(`[!] Search grounding failed (${error.message || error}). Falling back to standard generation...`);
    
    // Fallback: Query model WITHOUT the search tool
    const fallbackModel = genAI.getGenerativeModel({
      model: modelName,
    });

    const response = await fallbackModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: query }] }],
      systemInstruction: systemInstruction,
    });

    const text = response.response.text().trim();
    console.log('[+] Reply generated successfully using fallback model (no search grounding).');
    return { text, sources: '' };
  }
}
