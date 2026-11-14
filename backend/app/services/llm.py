"""Thin Gemini client shared by vision, memory and Bridge. httpx is imported lazily."""
import base64
import os

GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'


def configured() -> bool:
    return bool(os.getenv('GEMINI_API_KEY'))


def model() -> str:
    # The lite model answers in about a second, which matters for speech.
    return os.getenv('GEMINI_MODEL', 'gemini-flash-lite-latest')


def image_part(image: bytes, mime: str) -> dict:
    return {'inlineData': {'mimeType': mime, 'data': base64.b64encode(image).decode('ascii')}}


async def gemini(parts: list[dict], system: str = '', json_mode: bool = False, timeout: float = 10.0) -> str:
    """Send text and image parts, return the reply text. Raises on any failure."""
    import httpx
    config = {'temperature': 0.2, 'maxOutputTokens': 1024}
    if json_mode:
        config['responseMimeType'] = 'application/json'
    payload = {'contents': [{'role': 'user', 'parts': parts}], 'generationConfig': config}
    if system:
        payload['systemInstruction'] = {'parts': [{'text': system}]}
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4.0)) as client:
        response = await client.post(
            GEMINI_URL.format(model=model()),
            headers={'x-goog-api-key': os.environ['GEMINI_API_KEY']},
            json=payload,
        )
        response.raise_for_status()
    reply = response.json()['candidates'][0]['content']['parts']
    text = ' '.join(part['text'].strip() for part in reply if part.get('text') and not part.get('thought'))
    if not text:
        raise ValueError('Gemini returned no text')
    return text
