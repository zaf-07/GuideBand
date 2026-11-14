"""Speech through ElevenLabs: a natural voice out, and transcription in.

Both are optional. Without a key the web client keeps using the browser's own
speech, and hazard warnings always use the local voice so they never wait on
the network.
"""
from __future__ import annotations

import os

API = 'https://api.elevenlabs.io/v1'
DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'  # "Sarah": calm and clear
MAX_TEXT = 600


class SpeechError(Exception):
    pass


def configured() -> bool:
    return bool(os.getenv('ELEVENLABS_API_KEY'))


def _headers() -> dict:
    return {'xi-api-key': os.environ['ELEVENLABS_API_KEY']}


async def synthesize(text: str) -> bytes:
    """Text in, MP3 bytes out."""
    import httpx
    voice = os.getenv('ELEVENLABS_VOICE_ID', DEFAULT_VOICE)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=4.0)) as client:
            response = await client.post(
                f'{API}/text-to-speech/{voice}',
                params={'output_format': 'mp3_44100_64'},
                headers=_headers(),
                json={'text': text[:MAX_TEXT], 'model_id': os.getenv('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5')},
            )
            response.raise_for_status()
    except Exception as error:
        raise SpeechError(f'Voice service failed: {type(error).__name__}') from error
    return response.content


async def transcribe(audio: bytes, mime: str) -> str:
    """Short audio clip in, text out. The clip is not stored here."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=4.0)) as client:
            response = await client.post(
                f'{API}/speech-to-text',
                headers=_headers(),
                data={'model_id': os.getenv('ELEVENLABS_STT_MODEL', 'scribe_v1')},
                files={'file': ('speech', audio, mime)},
            )
            response.raise_for_status()
    except Exception as error:
        raise SpeechError(f'Transcription failed: {type(error).__name__}') from error
    return (response.json().get('text') or '').strip()
