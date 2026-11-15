#!/usr/bin/env python3
"""Keep the Vexo band connected as the always-on microphone of the GuideBand assistant.

    python scripts/band_assistant.py

The GuideBand service starts this by itself, so you normally never run it by hand.

One Bluetooth connection is opened and kept. The band's microphone is streamed to
Deepgram (the kit prints a line saying so, and the band's light turns solid blue),
and each finished sentence is handed to the local service, where the open live demo
handles it exactly like speech from the laptop microphone. If the band drops out
of range or goes to sleep, the script keeps looking for it and reconnects by itself.

Two things keep it quick and clean:

* A sentence is handed over as soon as its words stop changing for a moment. In a
  loud room the speech service may never decide that a sentence has ended.
* While the assistant is speaking, the band's audio is not sent on, so the
  assistant never hears its own voice through the band.

Only the team's own band (Vexo-HACK-20) is ever connected. Audio is not stored.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import guideband_vexo as bridge  # noqa: E402  (sets up the kit paths and loads backend/.env)

HEARTBEAT_SECONDS = 4
RETRY_SECONDS = (4, 8, 12)  # pause after the first, second and later failed attempts
QUIET_SECONDS = 1.6      # words unchanged for this long: the sentence is over
MAX_SENTENCE_SECONDS = 9  # never wait longer than this before handing a sentence over


def post(service: str, path: str, **fields) -> bool:
    body = urllib.parse.urlencode(fields).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(service + path, data=body), timeout=5) as response:
            return response.status < 300
    except Exception:
        return False


class Sentences:
    """Turns the speech service's running text into separate sentences, handed over promptly."""

    def __init__(self, deliver) -> None:
        self.deliver = deliver
        self.lock = threading.Lock()
        self.done = ''       # the part of the running text that was already handed over
        self.pending = ''    # words heard since then
        self.started = 0.0
        self.changed = 0.0

    def heard(self, text: str, final: bool) -> None:
        """Called by the speech service with everything said in the current sentence so far."""
        with self.lock:
            text = text.strip()
            if self.done and text.startswith(self.done):
                text = text[len(self.done):].strip()
            elif self.done:
                self.done = ''  # a new sentence began
            if text != self.pending:
                if not self.pending:
                    self.started = time.monotonic()
                self.pending, self.changed = text, time.monotonic()
            if final:
                self._hand_over(reset=True)

    def tick(self) -> None:
        """Called a few times a second: hand a sentence over once it has stopped changing."""
        with self.lock:
            if not self.pending:
                return
            now = time.monotonic()
            if now - self.changed >= QUIET_SECONDS or now - self.started >= MAX_SENTENCE_SECONDS:
                self._hand_over(reset=False)

    def clear(self) -> None:
        with self.lock:
            self.done, self.pending = (self.done + ' ' + self.pending).strip(), ''

    def _hand_over(self, reset: bool) -> None:
        sentence, self.pending = self.pending, ''
        self.done = '' if reset else (self.done + ' ' + sentence).strip()
        if sentence:
            self.deliver(sentence)


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

        muted = threading.Event()
        alive = threading.Event()
        alive.set()

        def deliver(sentence: str) -> None:
            if muted.is_set():
                return
            print('Heard:', sentence, flush=True)
            post(service, '/band/heard', text=sentence)

        sentences = Sentences(deliver)

        def watch_mute() -> None:
            """Ask the service a few times a second whether the assistant is speaking."""
            while alive.is_set():
                try:
                    with urllib.request.urlopen(service + '/band/mute', timeout=2) as response:
                        speaking = bool(json.load(response).get('muted'))
                except Exception:
                    speaking = False
                if speaking and not muted.is_set():
                    muted.set()
                    sentences.clear()
                elif not speaking and muted.is_set():
                    sentences.clear()
                    muted.clear()
                time.sleep(0.2)

        threading.Thread(target=watch_mute, daemon=True).start()

        def on_text(value: str, is_final: bool) -> None:
            if muted.is_set():
                return
            sentences.heard(value, is_final)

        ears = None
        while ears is None:
            try:
                ears = speech.create(language=language, endpointing=300).start(on_text)
            except Exception as problem:  # refused or unreachable: the band itself is fine, so keep it
                print('Speech service not ready, trying again:', str(problem).splitlines()[0][:120], flush=True)
                post(service, '/band/state', connected='true', name=band.name, battery=battery)
                if time.monotonic() >= deadline:
                    raise
                band.wait(5)  # also keeps the Bluetooth link alive

        def feed(*args, **kwargs) -> None:
            if not muted.is_set():  # the assistant is talking: do not send its voice on
                ears.feed(*args, **kwargs)

        band.on('audio', feed)
        try:
            band.configure(audio=True)
            next_beat = 0.0
            while time.monotonic() < deadline:
                band.wait(0.2)  # raises when the connection is lost
                sentences.tick()
                if time.monotonic() >= next_beat:
                    next_beat = time.monotonic() + HEARTBEAT_SECONDS
                    post(service, '/band/state', connected='true', name=band.name, battery=battery)
        finally:
            alive.clear()
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
    failures = 0
    while time.monotonic() < deadline:
        started = time.monotonic()
        try:
            session(transport, service, language, deadline)
        except KeyboardInterrupt:
            break
        except (SystemExit, Exception) as problem:  # not found, asleep, out of range: keep trying
            reason = str(problem).splitlines()[0][:120] if str(problem) else type(problem).__name__
            print('Band not connected:', reason, flush=True)
        # A connection that lasted a while was a good one: start the pauses from the beginning again.
        failures = 0 if time.monotonic() - started > 30 else failures + 1
        post(service, '/band/state', connected='false')
        time.sleep(RETRY_SECONDS[min(failures, len(RETRY_SECONDS)) - 1])
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
