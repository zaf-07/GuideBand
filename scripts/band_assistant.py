#!/usr/bin/env python3
"""Keep the Vexo band connected as the always-on microphone of the GuideBand assistant.

    python scripts/band_assistant.py

The GuideBand service starts this by itself, so you normally never run it by hand.

One Bluetooth connection is opened and kept. The band's microphone is streamed to
Deepgram (the kit prints a line saying so, and the band's light turns solid blue),
and each finished sentence is handed to the local service, where the open live demo
handles it exactly like speech from the laptop microphone. If the band drops out
of range or goes to sleep, the script keeps looking for it and reconnects by itself.

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

HEARTBEAT_SECONDS = 4
RETRY_SECONDS = 3


def post(service: str, path: str, **fields) -> bool:
    body = urllib.parse.urlencode(fields).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(service + path, data=body), timeout=5) as response:
            return response.status < 300
    except Exception:
        return False


def session(transport: str, service: str, language: str, deadline: float) -> None:
    """One connection, kept until it drops or the deadline passes."""
    import speech

    with bridge._connect(transport) as band:
        try:
            battery = band.get_battery().percent
        except Exception:
            battery = ''
        print(f'Connected to {band.name}. While its light is solid blue, nearby audio is sent to Deepgram: '
              'tell the people around you.', flush=True)
        post(service, '/band/state', connected='true', name=band.name, battery=battery)

        def on_text(value: str, is_final: bool) -> None:
            value = value.strip()
            if is_final and value:
                print('Heard:', value, flush=True)
                post(service, '/band/heard', text=value)

        # A slightly longer pause ends a sentence, so a request is not cut in the middle.
        ears = speech.create(language=language, endpointing=400).start(on_text)
        feed = ears.feed
        band.on('audio', feed)
        try:
            band.configure(audio=True)
            next_beat = 0.0
            while time.monotonic() < deadline:
                band.wait(0.2)  # raises when the connection is lost
                if time.monotonic() >= next_beat:
                    next_beat = time.monotonic() + HEARTBEAT_SECONDS
                    post(service, '/band/state', connected='true', name=band.name, battery=battery)
        finally:
            try:
                band.configure(audio=False)
            except Exception:
                pass
            band.off('audio', feed)
            try:
                ears.stop()
            except Exception:
                pass


def run(transport: str, minutes: float, service: str, language: str) -> None:
    deadline = time.monotonic() + minutes * 60
    while time.monotonic() < deadline:
        try:
            session(transport, service, language, deadline)
        except KeyboardInterrupt:
            break
        except (SystemExit, Exception) as problem:  # not found, asleep, out of range: keep trying
            reason = str(problem).splitlines()[0][:120] if str(problem) else type(problem).__name__
            print('Band not connected:', reason, flush=True)
        post(service, '/band/state', connected='false')
        time.sleep(RETRY_SECONDS)
    post(service, '/band/state', connected='false')
    print('Stopped. The band microphone is off.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Keep the Vexo band connected as the GuideBand microphone.')
    parser.add_argument('--transport', choices=('ble', 'serial', 'sim'), default='ble')
    parser.add_argument('--minutes', type=float, default=480)
    parser.add_argument('--service', default='http://127.0.0.1:8000')
    parser.add_argument('--language', default='en')
    args = parser.parse_args()
    try:
        run(args.transport, max(0.1, args.minutes), args.service.rstrip('/'), args.language)
    except KeyboardInterrupt:
        post(args.service.rstrip('/'), '/band/state', connected='false')
