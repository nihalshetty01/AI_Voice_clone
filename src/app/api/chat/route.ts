import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { transcribeAudio, generateGroundedReply } from '@/lib/gemini';

export const runtime = 'nodejs'; // Required to support Node.js Buffer operations

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let query = '';
  let transcriptionTime = 0;

  try {
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      // Handle audio upload for voice input
      const formData = await req.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
      }

      // Convert file to buffer for Gemini API
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const mimeType = file.type || 'audio/webm';

      const transcriptionStart = Date.now();
      // Transcribe audio
      query = await transcribeAudio(buffer, mimeType);
      transcriptionTime = Date.now() - transcriptionStart;

      if (!query) {
        return NextResponse.json({ error: 'Could not transcribe speech' }, { status: 422 });
      }
    } else {
      // Handle fallback JSON text input
      const body = await req.json();
      query = body.query || '';
    }

    if (!query.trim()) {
      return NextResponse.json({ error: 'Query is empty' }, { status: 400 });
    }

    console.log(`[*] Fetching persona style configuration from Supabase...`);
    // Fetch the latest styling configuration from Supabase
    const { data: config, error: configError } = await supabase
      .from('twin_persona_config')
      .select('whatsapp_extracted_style')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (configError || !config) {
      console.warn('[!] Style configuration not found in Supabase. Using a basic default Hinglish style.');
    }

    const systemPrompt = config?.whatsapp_extracted_style || 
      "You are Nihal's digital twin. Respond in short direct Romanized Hinglish sentences. Refuse toxic behavior. Keep it professional.";

    const generationStart = Date.now();
    // Generate grounded and styled reply
    const { text, sources } = await generateGroundedReply(query, systemPrompt);
    const generationTime = Date.now() - generationStart;

    const totalBackendLatency = Date.now() - startTime;

    console.log(`[*] Logging interaction to Supabase...`);
    // Save to interaction logs table in Supabase
    const { error: logError } = await supabase
      .from('voice_interaction_logs')
      .insert([
        {
          input_query: query,
          raw_factual_source: sources || null,
          final_hinglish_text: text,
          latency_ms: totalBackendLatency,
        },
      ]);

    if (logError) {
      console.error('[!] Error writing to interaction logs in Supabase:', logError);
    }

    return NextResponse.json({
      transcription: query,
      text,
      sources,
      latencies: {
        transcription: transcriptionTime,
        generation: generationTime,
        total: totalBackendLatency,
      },
    });

  } catch (error: any) {
    console.error('[!] Error in /api/chat route:', error);
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
