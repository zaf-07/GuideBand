"""GuideBand's private memory: what was seen, where and when.

Only short text is stored — object labels, positions and brief notes. Images
and audio are never written. Everything lives in one local SQLite file that the
user can wipe at any time.
"""
from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from . import llm

RECALL_PROMPT = (
    'You are GuideBand, the memory of a blind or low-vision person, speaking aloud. '
    'Answer the question using only the memory notes provided. '
    'Say where the thing was and how long ago it was seen, in one or two short sentences. '
    'If the notes do not contain the answer, say you have not seen it yet. Never guess.'
)
SNAPSHOT_PROMPT = (
    'Describe this scene for a personal memory log in at most three short sentences. '
    'Name notable objects and say what each one is on or next to. '
    'Quote any clearly readable text exactly. Do not identify or describe people.'
)
STOP_WORDS = {
    'where', 'did', 'does', 'do', 'you', 'see', 'seen', 'saw', 'last', 'leave', 'left', 'put', 'have',
    'what', 'that', 'this', 'the', 'my', 'are', 'is', 'was', 'were', 'say', 'said', 'remember', 'and',
    'for', 'with', 'any', 'there', 'here', 'it', 'me', 'a', 'an', 'of', 'in', 'on', 'i', 'to',
}


def age(seconds: float) -> str:
    if seconds < 45:
        return 'just now'
    minutes = round(seconds / 60)
    if minutes < 60:
        return f'{minutes} minute{"s" if minutes != 1 else ""} ago'
    hours = round(minutes / 60)
    if hours < 24:
        return f'{hours} hour{"s" if hours != 1 else ""} ago'
    days = round(hours / 24)
    return f'{days} day{"s" if days != 1 else ""} ago'


class Memory:
    def __init__(self, path: str | None = None) -> None:
        if path is None:
            path = os.getenv('MEMORY_DB') or str(Path(__file__).resolve().parents[2] / 'data' / 'memory.db')
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock, self._db:
            self._db.execute('CREATE TABLE IF NOT EXISTS sightings (label TEXT PRIMARY KEY, position TEXT, last_seen REAL, times INTEGER)')
            self._db.execute('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, kind TEXT, text TEXT, created REAL)')

    # ----- writing -----

    def record_detections(self, detections: list[dict], now: float | None = None) -> None:
        """Keep the latest position of each kind of object the detector has seen."""
        now = now or time.time()
        latest: dict[str, dict] = {}
        for item in detections:  # one row per label: keep the largest instance
            if item['label'] not in latest or item['area'] > latest[item['label']]['area']:
                latest[item['label']] = item
        with self._lock, self._db:
            for label, item in latest.items():
                self._db.execute(
                    'INSERT INTO sightings VALUES (?, ?, ?, 1) ON CONFLICT(label) DO UPDATE SET '
                    'position = excluded.position, last_seen = excluded.last_seen, times = times + 1',
                    (label, item['position'], now),
                )

    def add_note(self, kind: str, text: str, now: float | None = None) -> dict:
        now = now or time.time()
        with self._lock, self._db:
            cursor = self._db.execute('INSERT INTO notes (kind, text, created) VALUES (?, ?, ?)', (kind, text.strip(), now))
            # Keep the log small and recent.
            self._db.execute('DELETE FROM notes WHERE id <= ?', (cursor.lastrowid - int(os.getenv('MEMORY_MAX_NOTES', '200')),))
        return {'id': cursor.lastrowid, 'kind': kind, 'text': text.strip(), 'created': now}

    def clear(self) -> None:
        with self._lock, self._db:
            self._db.execute('DELETE FROM sightings')
            self._db.execute('DELETE FROM notes')

    # ----- reading -----

    def sightings(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute('SELECT label, position, last_seen, times FROM sightings ORDER BY last_seen DESC').fetchall()
        return [{'label': r[0], 'position': r[1], 'last_seen': r[2], 'times': r[3]} for r in rows]

    def notes(self, limit: int = 30) -> list[dict]:
        with self._lock:
            rows = self._db.execute('SELECT id, kind, text, created FROM notes ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        return [{'id': r[0], 'kind': r[1], 'text': r[2], 'created': r[3]} for r in rows]

    def context(self, now: float | None = None) -> str:
        """Everything remembered, as plain lines for the language model."""
        now = now or time.time()
        lines = [f'- note, {age(now - n["created"])}: {n["text"]}' for n in self.notes()]
        lines += [f'- detector saw a {s["label"]} {s["position"]}, {age(now - s["last_seen"])}' for s in self.sightings()[:30]]
        return '\n'.join(lines)

    def local_answer(self, question: str, now: float | None = None) -> str:
        """Keyword recall used when no cloud model is available."""
        now = now or time.time()
        words = {w for w in re.findall(r'[a-z]+', question.lower()) if w not in STOP_WORDS and len(w) > 2}
        words |= {w[:-1] for w in words if w.endswith('s')}  # keys -> key
        for note in self.notes():
            if words & set(re.findall(r'[a-z]+', note['text'].lower())):
                return f'{age(now - note["created"]).capitalize()} I noted: {note["text"]}'
        for sighting in self.sightings():
            if words & set(sighting['label'].split()):
                return f'I last saw a {sighting["label"]} {sighting["position"]}, {age(now - sighting["last_seen"])}.'
        return 'I have not seen that yet.'

    async def recall(self, question: str) -> dict:
        context = self.context()
        if context and llm.configured():
            try:
                text = await llm.gemini(
                    [{'text': f'Memory notes:\n{context}\n\nQuestion: {question}'}], system=RECALL_PROMPT,
                )
                return {'text': text, 'provider': 'gemini'}
            except Exception:
                pass  # fall through to keyword recall
        return {'text': self.local_answer(question), 'provider': 'local'}

    async def snapshot(self, image: bytes, mime: str, fallback: str) -> dict:
        """Describe a frame into a text note. The frame itself is discarded."""
        text, provider = fallback, 'local'
        if llm.configured():
            try:
                text = await llm.gemini([llm.image_part(image, mime), {'text': SNAPSHOT_PROMPT}])
                provider = 'gemini'
            except Exception:
                pass
        note = self.add_note('snapshot', text)
        note['provider'] = provider
        return note
