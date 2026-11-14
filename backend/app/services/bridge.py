"""Bridge: experimental sign reading.

A few camera frames in time order are sent to the vision model, which is asked
for a short English reading and its own confidence. Low-confidence readings are
dropped rather than spoken. This is a demo of the idea, not sign-language
translation: it will miss and misread signs.
"""
import json

from . import llm

MIN_CONFIDENCE = 0.6
MAX_FRAMES = 4

SIGN_PROMPT = (
    'The images are consecutive camera frames, in time order, of one person who may be signing '
    'in American Sign Language or fingerspelling. Reply with JSON only: '
    '{"text": "<the word or short phrase signed, in English>", "confidence": <0 to 1>}. '
    'If nobody is signing, or you cannot tell with confidence, use an empty text and a low confidence. '
    'Never invent a phrase.'
)


def parse_reading(raw: str) -> dict:
    """Validate the model's JSON and drop anything below the confidence bar."""
    try:
        data = json.loads(raw)
        text = str(data.get('text', '')).strip()[:120]
        confidence = max(0.0, min(1.0, float(data.get('confidence', 0))))
    except (ValueError, TypeError, AttributeError):
        return {'text': '', 'confidence': 0.0}
    if confidence < MIN_CONFIDENCE:
        text = ''
    return {'text': text, 'confidence': round(confidence, 2)}


async def read_sign(frames: list[tuple[bytes, str]]) -> dict:
    parts = [llm.image_part(image, mime) for image, mime in frames[:MAX_FRAMES]]
    parts.append({'text': SIGN_PROMPT})
    try:
        reading = parse_reading(await llm.gemini(parts, json_mode=True, timeout=12.0))
        reading['provider'] = 'gemini'
    except Exception as error:
        reading = {'text': '', 'confidence': 0.0, 'provider': None, 'error': type(error).__name__}
    reading['experimental'] = True
    return reading
