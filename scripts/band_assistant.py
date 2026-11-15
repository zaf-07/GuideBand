#!/usr/bin/env python3
"""Make the Vexo band the microphone of the GuideBand assistant.

    python scripts/band_assistant.py            # runs until Ctrl+C
    python scripts/band_assistant.py --minutes 5

The band's microphone is streamed to Deepgram for transcription (the kit prints
a line saying so, and the band's light turns solid blue). Every finished
sentence is handed to the local GuideBand service, where the open live demo
picks it up exactly as if it had been spoken to the laptop: it uses the camera,
answers aloud, and still waits for a spoken yes before paying or messaging.

Only the team's own band (Vexo-HACK-20) is ever connected. Audio is not stored.
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import guideband_vexo as bridge  # noqa: E402  (sets up the kit paths and loads backend/.env)


def hand_over(service: str, text: str) -> bool:
    """Give one heard sentence to the GuideBand service."""
    body = urllib.parse.urlencode({'text': text}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(service + '/band/heard', data=body), timeout=5) as response:
            return response.status < 300
    except Exception as error:
        print(f'  (could not reach the GuideBand service: {error})')
        return False


def run(transport: str, minutes: float, service: str, language: str) -> None:
    import speech

    with bridge._connect(transport) as band:
        print(f'Connected to {band.name}. While its light is solid blue, nearby audio is sent to Deepgram: '
              'tell the people around you.')

        def on_text(value: str, is_final: bool) -> None:
            if not is_final:
                return
            value = value.strip()
            if value:
                print('Heard:', value, '' if hand_over(service, value) else '(not delivered)')

        # A slightly longer pause ends a sentence, so a request is not cut in the middle.
        ears = speech.create(language=language, endpointing=400).start(on_text)
        feed = ears.feed
        band.on('audio', feed)
        try:
            band.configure(audio=True)
            print('Listening through the band. Press Ctrl+C to stop.')
            deadline = time.monotonic() + minutes * 60
            while time.monotonic() < deadline:
                band.wait(0.2)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                band.configure(audio=False)
            finally:
                band.off('audio', feed)
                ears.stop()
        print('Stopped. The band microphone is off.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Use the Vexo band as the GuideBand microphone.')
    parser.add_argument('--transport', choices=('ble', 'serial', 'sim'), default='ble')
    parser.add_argument('--minutes', type=float, default=30)
    parser.add_argument('--service', default='http://127.0.0.1:8000')
    parser.add_argument('--language', default='en')
    args = parser.parse_args()
    run(args.transport, max(0.1, min(120, args.minutes)), args.service.rstrip('/'), args.language)
