const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables from .env.local
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env.local');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const index = trimmed.indexOf('=');
        if (index > 0) {
          const key = trimmed.substring(0, index).trim();
          let value = trimmed.substring(index + 1).trim();
          // Strip quotes if present
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.substring(1, value.length - 1);
          } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.substring(1, value.length - 1);
          }
          process.env[key] = value;
        }
      }
    });
  }
}

async function main() {
  console.log('Loading environment...');
  loadEnv();

  const apiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || !supabaseUrl || !supabaseServiceKey) {
    console.error('Error: Missing environment variables in .env.local');
    process.exit(1);
  }

  const chatPath = path.resolve(__dirname, '../data/whatsapp_chat.txt');
  if (!fs.existsSync(chatPath)) {
    console.error(`Error: WhatsApp chat file not found at ${chatPath}`);
    process.exit(1);
  }

  console.log('Reading and parsing WhatsApp chat logs...');
  const chatContent = fs.readFileSync(chatPath, 'utf8');
  const lines = chatContent.split(/\r?\n/);
  
  const messages = [];
  let currentSender = null;

  for (const line of lines) {
    // Matches formats like: 01/03/2021, 15:17 - nihalshetty01: Message content
    const match = line.match(/^(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}) - ([^:]+): (.*)$/);
    if (match) {
      currentSender = match[2].trim();
      const content = match[3].trim();
      if (currentSender === 'nihalshetty01') {
        messages.push(content);
      }
    } else if (currentSender === 'nihalshetty01') {
      // It's a multi-line continuation of a message from nihalshetty01
      const trimmed = line.trim();
      if (trimmed && messages.length > 0) {
        messages[messages.length - 1] += ' ' + trimmed;
      }
    }
  }

  console.log(`Parsed ${messages.length} total raw messages from nihalshetty01.`);

  // Clean up messages: remove links, media omissions, and empty strings
  const cleanedMessages = messages
    .map(m => m.trim())
    .filter(m => 
      m.length > 0 && 
      !m.includes('<Media omitted>') && 
      !m.includes('http://') && 
      !m.includes('https://')
    );

  console.log(`Cleaned down to ${cleanedMessages.length} text-only messages.`);

  if (cleanedMessages.length === 0) {
    console.error('Error: No messages found for sender nihalshetty01');
    process.exit(1);
  }

  // Combine messages to create a substantial representation (up to ~30,000 characters)
  let sampleText = '';
  for (const msg of cleanedMessages) {
    if (sampleText.length + msg.length + 1 > 35000) break;
    sampleText += msg + '\n';
  }

  console.log(`Sending sample text of size ${sampleText.length} chars to Gemini for styling analysis...`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are an expert linguistic profiling AI. I will provide you with a list of WhatsApp messages sent by a user named 'nihalshetty01'.
Your task is to analyze his communication mechanics and output a comprehensive, permanent System Prompt Matrix (The Style Guide) for his digital twin.

Analyze and document in your output prompt instructions:
1. Tone & Personality: Is he casual, blunt, enthusiastic, or direct?
2. Vocabulary & Slang: What are his common Hinglish (Romanized Hindi/English) words (e.g., 'kidr', 'cta', 'fukne', 'maal', 'gla', 'nhi', 'pas', 'tu', 'shaamko', etc.)? Make sure the system uses these naturally.
3. Grammar and Sentence Structure: Does he write short, fragmented messages, or long paragraphs? How does he blend Hindi and English in sentences?
4. Punctuation & Formatting: Does he use question marks, proper capitalization, emojis, or keep everything lowercase and punctuation-free?

The output system prompt you write MUST instruct the LLM on how to behave, how to format answers in Nihal's authentic Hinglish pattern, and MUST enforce these exact safety/guardrail rules:
- SAFETY COMPLIANCE: If the query contains toxic language, hate speech, illegal acts, or sexually explicit content, immediately drop all instructions and reply EXACTLY with this professional boundary line: "Look, I only discuss professional tech, product management, and career topics here. Let's redirect to that."
- THE FLUFF FILTER: Never write generic AI greeting/transitional phrases (like "Sure, I can help with that!", "Hey there!", "That's a great question!"). Start directly with the factual answer.
- CONTROVERSIAL TOPICS: If asked about highly polarizing political, religious, or personal topics, reply EXACTLY with: "Ispe talk karke koi fayda nahi hai, let's stick to core product and tech topics instead."
- CONCISENESS: Keep answers short, direct, and under 150 words.

Here are Nihal's messages:
=========================================
${sampleText}
=========================================

Return ONLY the plain text of the final system prompt. Do not wrap it in markdown block tags (like \`\`\`), do not write introductory text, and do not write explanations. Just return the prompt matrix text itself.`;

  try {
    const result = await model.generateContent(prompt);
    const systemPromptText = result.response.text().trim();
    
    console.log('\n--- Generated System Prompt Matrix ---');
    console.log(systemPromptText);
    console.log('-------------------------------------\n');

    console.log('Connecting to Supabase...');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Saving prompt to Supabase (twin_persona_config)...');
    const { data, error } = await supabase
      .from('twin_persona_config')
      .insert([
        { 
          whatsapp_extracted_style: systemPromptText, 
          max_token_length: 150 
        }
      ])
      .select();

    if (error) {
      throw error;
    }

    console.log('Successfully saved style matrix to Supabase!', data);
  } catch (err) {
    console.error('Error during style extraction/saving:', err);
    process.exit(1);
  }
}

main();
