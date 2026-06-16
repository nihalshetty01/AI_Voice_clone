-- Profile Configuration Table
CREATE TABLE twin_persona_config (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    whatsapp_extracted_style TEXT NOT NULL, -- The permanent system prompt matrix
    max_token_length INT DEFAULT 150 -- Keeps voice answers concise and natural
);

-- Interaction Logs for Latency & Performance Auditing
CREATE TABLE voice_interaction_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    input_query TEXT NOT NULL,
    raw_factual_source TEXT, 
    final_hinglish_text TEXT NOT NULL,
    latency_ms INT 
);
