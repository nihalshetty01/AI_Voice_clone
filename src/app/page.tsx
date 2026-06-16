'use client';

import { useState, useRef, useEffect } from 'react';

interface LatencyStats {
  transcription: number;
  generation: number;
  synthesis: number;
  total: number;
}

interface Message {
  id: string;
  sender: 'user' | 'twin';
  text: string;
  sources?: string;
  audioUrl?: string;
  latencies?: LatencyStats;
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [statusText, setStatusText] = useState('Tap Mic to Speak');
  const [isProcessing, setIsProcessing] = useState(false);
  const [chatLog, setChatLog] = useState<Message[]>([]);
  const [localEngineOffline, setLocalEngineOffline] = useState(false);
  const [textInput, setTextInput] = useState('');
  
  // Latency states
  const [currentLatencies, setCurrentLatencies] = useState<LatencyStats | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  // Check if local engine is running on mount
  useEffect(() => {
    checkLocalEngine();
  }, []);

  const checkLocalEngine = async () => {
    try {
      const res = await fetch('http://127.0.0.1:5002/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'test', language: 'en' })
      });
      setLocalEngineOffline(res.status !== 200 && res.status !== 400);
    } catch {
      setLocalEngineOffline(true);
    }
  };

  // Canvas visualizer loop
  const startVisualizer = (stream: MediaStream) => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const draw = () => {
        if (!analyserRef.current) return;
        animationFrameRef.current = requestAnimationFrame(draw);
        analyserRef.current.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw centered particle wave
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = 60;

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)'; // Sky blue translucent
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let i = 0; i < bufferLength; i++) {
          const angle = (i / bufferLength) * Math.PI * 2;
          const value = dataArray[i] / 255;
          const offset = value * 45;
          const x = centerX + Math.cos(angle) * (radius + offset);
          const y = centerY + Math.sin(angle) * (radius + offset);

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();
        ctx.stroke();

        // Inner glowing core
        const glow = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, radius);
        glow.addColorStop(0, 'rgba(56, 189, 248, 0.6)');
        glow.addColorStop(0.5, 'rgba(168, 85, 247, 0.2)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fill();
      };

      draw();
    } catch (e) {
      console.error('Visualizer error:', e);
    }
  };

  const stopVisualizer = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;

    // Clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  // Mic recording trigger
  const toggleRecording = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        setStatusText('Analyzing Speech...');
      }
      setIsRecording(false);
      stopVisualizer();
    } else {
      // Start recording
      audioChunksRef.current = [];
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        let mimeType = 'audio/webm';
        if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
          mimeType = 'audio/ogg';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        }

        const mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          // Cleanup raw audio streams
          stream.getTracks().forEach((track) => track.stop());
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          await handleSpeechInput(audioBlob, mimeType);
        };

        mediaRecorder.start(250); // Get chunks every 250ms
        setIsRecording(true);
        setStatusText('Listening (Tap to stop)...');
        startVisualizer(stream);
      } catch (err) {
        console.error('Microphone access denied:', err);
        setStatusText('Mic Blocked - Check Permissions');
      }
    }
  };

  // Main Speech Flow Coordinator
  const handleSpeechInput = async (audioBlob: Blob, mimeType: string) => {
    setIsProcessing(true);
    setStatusText('Transcribing Audio...');

    try {
      // 1. Upload audio to Next.js API Route for transcription + Gemini search
      const formData = new FormData();
      formData.append('file', audioBlob, `query.${mimeType.split('/')[1]}`);

      const chatRes = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });

      if (!chatRes.ok) {
        const errJson = await chatRes.json();
        throw new Error(errJson.error || 'Server error during transcription.');
      }

      const chatData = await chatRes.json();
      const userText = chatData.transcription;
      const twinText = chatData.text;
      const sources = chatData.sources;
      const backendLatencies = chatData.latencies; // { transcription, generation, total }

      // Update state for User Message
      const userMsgId = 'user-' + Date.now();
      const twinMsgId = 'twin-' + Date.now();

      setChatLog((prev) => [
        ...prev,
        { id: userMsgId, sender: 'user', text: userText }
      ]);

      setStatusText('Generating Voice Clone...');

      // 2. Synthesize output voice using local engine or fallback
      let audioUrl = '';
      let synthesisLatency = 0;

      try {
        const ttsStart = Date.now();
        const ttsRes = await fetch('http://127.0.0.1:5002/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: twinText, language: 'en' }),
        });

        if (ttsRes.ok) {
          const ttsBlob = await ttsRes.blob();
          audioUrl = URL.createObjectURL(ttsBlob);
          synthesisLatency = parseInt(ttsRes.headers.get('X-Synthesis-Latency-MS') || '0');
          setLocalEngineOffline(false);
        } else {
          throw new Error('Local synthesis engine returned error status');
        }
      } catch (ttsErr) {
        console.warn('Local TTS failed, using browser fallback:', ttsErr);
        setLocalEngineOffline(true);
        // Fallback: Use browser synthesis
        speakBrowserFallback(twinText);
        synthesisLatency = 0; // Fallback has no server latency
      }

      // Compute final latencies
      const totalLatency = backendLatencies.total + synthesisLatency;
      const updatedLatencies: LatencyStats = {
        transcription: backendLatencies.transcription,
        generation: backendLatencies.generation,
        synthesis: synthesisLatency,
        total: totalLatency,
      };

      setCurrentLatencies(updatedLatencies);

      // Append Twin response to log
      setChatLog((prev) => [
        ...prev,
        {
          id: twinMsgId,
          sender: 'twin',
          text: twinText,
          sources: sources,
          audioUrl: audioUrl || undefined,
          latencies: updatedLatencies,
        }
      ]);

      // 3. Play the synthesized clone voice immediately
      if (audioUrl) {
        playAudio(audioUrl);
      }

      setStatusText('Ready');

    } catch (err: any) {
      console.error(err);
      setStatusText(err.message || 'Operation failed');
    } finally {
      setIsProcessing(false);
    }
  };

  // Text query fallback option
  const handleTextInputSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || isProcessing) return;

    const queryText = textInput;
    setTextInput('');
    setIsProcessing(true);
    setStatusText('Thinking...');

    try {
      const userMsgId = 'user-' + Date.now();
      const twinMsgId = 'twin-' + Date.now();

      setChatLog((prev) => [
        ...prev,
        { id: userMsgId, sender: 'user', text: queryText }
      ]);

      const chatRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText }),
      });

      if (!chatRes.ok) {
        const errJson = await chatRes.json();
        throw new Error(errJson.error || 'Server error.');
      }

      const chatData = await chatRes.json();
      const twinText = chatData.text;
      const sources = chatData.sources;
      const backendLatencies = chatData.latencies;

      setStatusText('Generating Voice Clone...');

      let audioUrl = '';
      let synthesisLatency = 0;

      try {
        const ttsRes = await fetch('http://127.0.0.1:5002/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: twinText, language: 'en' }),
        });

        if (ttsRes.ok) {
          const ttsBlob = await ttsRes.blob();
          audioUrl = URL.createObjectURL(ttsBlob);
          synthesisLatency = parseInt(ttsRes.headers.get('X-Synthesis-Latency-MS') || '0');
          setLocalEngineOffline(false);
        } else {
          throw new Error('TTS Failed');
        }
      } catch {
        setLocalEngineOffline(true);
        speakBrowserFallback(twinText);
      }

      const totalLatency = backendLatencies.total + synthesisLatency;
      const updatedLatencies: LatencyStats = {
        transcription: 0, // No transcription for text inputs
        generation: backendLatencies.generation,
        synthesis: synthesisLatency,
        total: totalLatency,
      };

      setCurrentLatencies(updatedLatencies);

      setChatLog((prev) => [
        ...prev,
        {
          id: twinMsgId,
          sender: 'twin',
          text: twinText,
          sources: sources,
          audioUrl: audioUrl || undefined,
          latencies: updatedLatencies,
        }
      ]);

      if (audioUrl) {
        playAudio(audioUrl);
      }
      setStatusText('Ready');

    } catch (err: any) {
      console.error(err);
      setStatusText('Failed to fetch response');
    } finally {
      setIsProcessing(false);
    }
  };

  const playAudio = (url: string) => {
    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
    }
    const audio = new Audio(url);
    activeAudioRef.current = audio;
    audio.play().catch((e) => console.log('Audio playback blocked/interrupted:', e));
  };

  const speakBrowserFallback = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      // Try to find a Hinglish or Indian English voice if available
      const voices = window.speechSynthesis.getVoices();
      const nativeVoice = voices.find(v => v.lang.includes('IN') || v.lang.includes('hi'));
      if (nativeVoice) utterance.voice = nativeVoice;
      window.speechSynthesis.speak(utterance);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="branding">
          <span className="live-status-dot"></span>
          <h1>Nihal AI Twin</h1>
          <span className="badge">100% FREE</span>
        </div>
        <p className="subtitle">Speak with my offline voice cloned persona (Hinglish/English)</p>
      </header>

      {localEngineOffline && (
        <div className="offline-warning">
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span>
            <strong>Offline Voice Server Mode:</strong> Local synthesis server (port 5002) is not responding. Voice clone is offline. Falling back to browser text-to-speech. Run `uv run --python 3.11 local_engine.py` to activate your offline cloned voice!
          </span>
        </div>
      )}

      <main className="main-layout">
        {/* Chat Feed */}
        <section className="feed-container">
          <div className="chat-history">
            {chatLog.length === 0 ? (
              <div className="empty-state">
                <div className="twin-avatar">NS</div>
                <h2>Ask Nihal anything</h2>
                <p>Query my clone about product management, technology, or my career background. I'll search the live web and speak back in my authentic voice.</p>
              </div>
            ) : (
              chatLog.map((msg) => (
                <div key={msg.id} className={`message-row ${msg.sender}`}>
                  <div className="avatar">{msg.sender === 'user' ? 'U' : 'NS'}</div>
                  <div className="message-content">
                    <p className="message-text">{msg.text}</p>
                    
                    {msg.sources && (
                      <div className="sources-container">
                        <span className="sources-label">Sources:</span>
                        <div className="sources-list">
                          {msg.sources.split('\n').map((sourceLine, idx) => {
                            const match = sourceLine.match(/\[(.*?)\]\((.*?)\)/);
                            if (match) {
                              return (
                                <a key={idx} href={match[2]} target="_blank" rel="noopener noreferrer" className="source-link">
                                  {match[1]}
                                </a>
                              );
                            }
                            return <span key={idx} className="source-link">{sourceLine}</span>;
                          })}
                        </div>
                      </div>
                    )}

                    {msg.sender === 'twin' && msg.audioUrl && (
                      <button onClick={() => playAudio(msg.audioUrl!)} className="replay-btn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        Replay Cloned Voice
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Text Input Fallback */}
          <form onSubmit={handleTextInputSubmit} className="text-input-form">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Or type your message here..."
              disabled={isProcessing}
            />
            <button type="submit" disabled={isProcessing || !textInput.trim()}>
              Send
            </button>
          </form>
        </section>

        {/* Console / Recording Area */}
        <section className="dashboard-panel">
          <div className="orb-container">
            <canvas ref={canvasRef} width="300" height="300" className="visualizer-canvas"></canvas>
            <button
              onClick={toggleRecording}
              className={`mic-orb ${isRecording ? 'recording' : ''} ${isProcessing ? 'processing' : ''}`}
              aria-label="Toggle recording"
              disabled={isProcessing}
            >
              <div className="pulse-glowing-ring"></div>
              <div className="orb-center-icon">
                {isRecording ? (
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1v11a4 4 0 0 0 4-4V5a4 4 0 0 0-8 0v3a4 4 0 0 0 4 4z"></path>
                    <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                  </svg>
                )}
              </div>
            </button>
            <p className="status-label">{statusText}</p>
          </div>

          {/* Latency Dashboard */}
          <div className="latency-dashboard">
            <h3>Latency Auditing</h3>
            <div className="latency-stats">
              <div className="stat-card">
                <span className="label">Speech To Text</span>
                <span className="value">
                  {currentLatencies ? `${currentLatencies.transcription} ms` : '--'}
                </span>
              </div>
              <div className="stat-card">
                <span className="label">Search + Response</span>
                <span className="value">
                  {currentLatencies ? `${currentLatencies.generation} ms` : '--'}
                </span>
              </div>
              <div className="stat-card">
                <span className="label">Voice Synthesis</span>
                <span className="value">
                  {currentLatencies ? `${currentLatencies.synthesis} ms` : '--'}
                </span>
              </div>
              <div className="stat-card total">
                <span className="label">Total Roundtrip</span>
                <span className="value">
                  {currentLatencies ? `${(currentLatencies.total / 1000).toFixed(2)} s` : '--'}
                </span>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
