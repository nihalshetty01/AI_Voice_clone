# /// script
# requires-python = ">=3.10,<3.12"
# dependencies = [
#     "coqui-tts",
#     "fastapi",
#     "uvicorn",
#     "pydantic",
#     "torch",
#     "torchaudio",
#     "soundfile",
#     "transformers<=4.39.3",
#     "miniaudio",
# ]
# ///

import os
import sys
import tempfile
import time

# Apply monkeypatch to coqpit to fix Python 3.10/3.11+ type hint and union validation issues
try:
    import coqpit.coqpit
    original_deserialize = coqpit.coqpit._deserialize
    def safe_deserialize(x, field_type):
        try:
            return original_deserialize(x, field_type)
        except (TypeError, ValueError):
            return x
    coqpit.coqpit._deserialize = safe_deserialize
    print("[*] Applied coqpit typing and deserialization compatibility monkeypatch successfully.")
except Exception as patch_err:
    print(f"[!] Warning: Failed to apply coqpit monkeypatch: {patch_err}")

# Apply monkeypatch to torch.load to fix PyTorch 2.6+ weights_only loading issues
try:
    import torch
    original_torch_load = torch.load
    def safe_torch_load(*args, **kwargs):
        if 'weights_only' not in kwargs:
            kwargs['weights_only'] = False
        return original_torch_load(*args, **kwargs)
    torch.load = safe_torch_load
    print("[*] Applied torch.load compatibility monkeypatch successfully.")
except Exception as torch_err:
    print(f"[!] Warning: Failed to apply torch.load monkeypatch: {torch_err}")

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Zero-Cost Local TTS Voice Clone Engine")

# Configure CORS so the Next.js frontend (running on port 3000 or production Vercel) can make API calls directly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your Vercel domains or local port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# File Paths
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
MP3_SOURCE = os.path.join(DATA_DIR, "Nihal_voice_ clone_recording.mp3")
WAV_REF = os.path.join(DATA_DIR, "reference_voice.wav")

tts = None

class TTSRequest(BaseModel):
    text: str
    language: str = "en"  # Options: en, hi, es, fr, de, it, pt, pl, tr, ru, nl, cs, ar, zh-cn, ja, hu, ko

def crop_voice_reference():
    """
    Trims the MP3 file down to a clean 10-second WAV reference file for faster synthesis.
    Uses miniaudio to decode MP3 (which is robust on Windows) and wave to save WAV.
    """
    # If WAV exists but is actually just a copy of the MP3 file (same size), delete it
    if os.path.exists(WAV_REF) and os.path.exists(MP3_SOURCE):
        if os.path.getsize(WAV_REF) == os.path.getsize(MP3_SOURCE):
            print("[*] Detected fallback MP3 copy at reference path. Deleting it to force a clean WAV crop.")
            try:
                os.remove(WAV_REF)
            except Exception as e:
                print(f"[!] Warning: failed to delete old fallback: {e}")

    if os.path.exists(WAV_REF):
        print(f"[*] Reference voice WAV already exists at: {WAV_REF}")
        return

    print(f"[*] Creating trimmed reference voice from: {MP3_SOURCE}")
    if not os.path.exists(MP3_SOURCE):
        print(f"[!] Error: Source recording not found at {MP3_SOURCE}")
        return

    try:
        import miniaudio
        import wave
        
        print("[*] Decoding MP3 using miniaudio...")
        decoded = miniaudio.decode_file(MP3_SOURCE)
        print(f"[+] Decoded MP3. Rate: {decoded.sample_rate}Hz, Channels: {decoded.nchannels}, Duration: {decoded.duration:.2f}s")
        
        # Crop to first 10 seconds
        target_duration = 10.0
        sliced_samples = decoded.samples
        if decoded.duration > target_duration:
            print(f"[*] Slicing first {target_duration} seconds of audio...")
            sliced_samples = decoded.samples[:decoded.sample_rate * int(target_duration) * decoded.nchannels]
            
        print(f"[*] Saving real WAV file to: {WAV_REF}")
        with wave.open(WAV_REF, 'wb') as wav_file:
            wav_file.setnchannels(decoded.nchannels)
            wav_file.setsampwidth(decoded.sample_width)
            wav_file.setframerate(decoded.sample_rate)
            wav_file.writeframes(sliced_samples.tobytes())
            
        print(f"[+] Successfully saved clean 10s voice clone reference to: {WAV_REF}")
    except Exception as e:
        print(f"[!] Failed to auto-crop voice reference: {e}")
        print("[!] Falling back to copying raw file (synthesis may fail if backend requires WAV).")
        import shutil
        shutil.copy(MP3_SOURCE, WAV_REF)

@app.on_event("startup")
def startup_event():
    global tts
    print("=" * 60)
    print("Starting Zero-Cost Local Voice Clone Engine...")
    print("=" * 60)
    
    # Ensure data directory exists
    os.makedirs(DATA_DIR, exist_ok=True)
    
    # Crop voice reference to 10s WAV
    crop_voice_reference()
    
    # Determine the reference path to use
    ref_path = WAV_REF if os.path.exists(WAV_REF) else MP3_SOURCE
    if not os.path.exists(ref_path):
        print(f"[FATAL] No voice reference file found at {ref_path}. Make sure to place your recording in the 'data' directory.")
        sys.exit(1)
        
    print(f"[*] Loading XTTS-v2 voice cloning model (Running on CPU)...")
    try:
        from TTS.api import TTS
        # Initialize XTTS v2
        # We enforce gpu=False to prevent 2GB VRAM overflow on the GeForce MX350
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
        print("[+] XTTS-v2 Model loaded successfully!")
    except Exception as e:
        print(f"[FATAL] Failed to load XTTS-v2 model: {e}")
        sys.exit(1)

def cleanup_file(filepath: str):
    """Utility to delete temporary audio files after streaming is done"""
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
            print(f"[-] Cleaned up temp file: {filepath}")
    except Exception as e:
        print(f"[!] Error deleting temp file {filepath}: {e}")

@app.post("/api/tts")
async def generate_tts(req: TTSRequest, background_tasks: BackgroundTasks):
    global tts
    if tts is None:
        raise HTTPException(status_code=503, detail="TTS Model is not loaded yet.")
        
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text query cannot be empty.")
        
    # Check reference file
    ref_path = WAV_REF if os.path.exists(WAV_REF) else MP3_SOURCE
    if not os.path.exists(ref_path):
        raise HTTPException(status_code=500, detail="No reference voice found in /data/ directory.")

    print(f"[*] Generating speech for: \"{req.text[:60]}...\" in language: {req.language}")
    
    try:
        # Create a temp file to output the generated WAV
        temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        temp_path = temp_file.name
        temp_file.close()

        start_time = time.time()
        
        # Run TTS model voice cloning inference
        tts.tts_to_file(
            text=req.text,
            speaker_wav=ref_path,
            language=req.language,
            file_path=temp_path
        )
        
        latency = (time.time() - start_time) * 1000
        print(f"[+] Synthesis complete in {latency:.1f}ms. Output file: {temp_path}")
        
        # Schedule the temp file for deletion after streaming
        background_tasks.add_task(cleanup_file, temp_path)
        
        # Stream the audio file back to the client
        def stream_file():
            with open(temp_path, "rb") as audio_file:
                yield from audio_file
                
        return StreamingResponse(
            stream_file(), 
            media_type="audio/wav",
            headers={"X-Synthesis-Latency-MS": str(int(latency))}
        )
        
    except Exception as e:
        print(f"[!] Synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"Voice synthesis error: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("local_engine:app", host="127.0.0.1", port=5002, reload=False)
