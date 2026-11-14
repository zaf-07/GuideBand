# GuideBand

**The AI that sees, remembers, and acts for you.**

GuideBand is a hands-free AI assistant for blind and low-vision people. A Vexo bracelet is the voice: the user just talks. A chest-clipped phone is the eyes. An agent keeps a private memory of what it saw and heard, and takes real actions — like paying — only after a spoken "yes".

Built at VexoHacks 2026 (AI Wearables Hackathon, Y Combinator, San Francisco).

> Prototype assistive technology. GuideBand is not a replacement for a white cane, guide dog, orientation and mobility training, emergency services or verified navigation instructions.

## The problem

Today's vision apps for blind users live on a phone screen. You have to aim the phone and tap buttons, which is exactly what a blind user struggles with. They also forget everything the moment you close them.

## What it does

- **See** — live hazard warnings spoken through the bracelet: "Chair ahead, left."
- **Remember** — ask later: "Where did I leave my keys?" or "What did that sign say?"
- **Act** — "Buy me a coffee": it reads the item and price aloud and pays only after a spoken yes.
- **Bridge** (stretch) — a deaf–blind bridge: sign language voiced aloud, speech shown as large captions.

## How it works

Hybrid by design: safety-critical detection runs locally and privately; reasoning and voice use the cloud.

| Layer | Component | Role |
| --- | --- | --- |
| Wearables | Vexo bracelet | Microphone in, voice out, hands-free |
| Wearables | Phone camera (chest clip) | The eyes |
| Local | Laptop (RTX 4050) | YOLO hazard detection, on-device |
| Agent | Mastra agent | Tools: `see`, `recall`, `pay`; spoken yes before paying |
| Services | Gemini Live | Vision and reasoning |
| Services | ElevenLabs | Speech in and out |
| Services | Memory store | Objects, text, places |
| Services | Stripe | Test-mode payment |

## Status

This table is the honest state of the repository, not the pitch.

| Part | State |
| --- | --- |
| Landing page (`web/index.html`) | Built |
| Voice app PWA (`web/app.html`): hold-to-talk, reminders, Journey mode, Guardian sharing, Bridge captions, spoken confirmations | Built (demo logic, runs in the browser) |
| Android assistant (`android/`): wake phrase, phone control, confirmation screens | Built |
| Desktop shell (`desktop/`) | Built |
| FastAPI service (`backend/`): command planning, tasks, events | Built |
| Vexo USB probe (`scripts/vexo_probe.py`) | Built, read-only |
| See — `POST /vision/analyze`: local YOLO hazard warnings plus a Gemini scene description, with fallbacks | Built in the backend; not yet connected to the phone camera or voice |
| Remember — personal memory and recall | Planned |
| Act — Stripe payment gated by a spoken yes | Planned |
| Agent, Gemini Live and ElevenLabs integration | Planned |
| Vexo bracelet microphone and haptics | Blocked until Vexo supplies the hackathon SDK; the phone is the fallback |

## Repository layout

```
web/        Landing page (index.html) and the voice app PWA (app.html)
android/    Android assistant app
desktop/    Electron shell around the voice app
backend/    FastAPI command / task / event service and tests
scripts/    Vexo USB probe
docs/       Product notes and research
```

## Run

Serve the `web` folder:

```bash
python -m http.server 4173 --directory web
```

Open `http://localhost:4173` for the landing page, or `http://localhost:4173/app.html` for the voice app. On Android Chrome, choose **Add to Home screen**. Speech recognition, camera and microphone need HTTPS or localhost; touch controls remain available.

Optional API (macOS / Linux):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

For vision, copy `backend/.env.example` to `backend/.env` and set `GEMINI_API_KEY`. Local hazard detection additionally needs `pip install -r backend/requirements-vision.txt`; without it the endpoint answers through the cloud model only. If Gemini fails, the optional Groq provider is tried, then a sentence built from the local detections.

On Windows PowerShell, activate with `.\.venv\Scripts\Activate.ps1` instead.

For a phone on the same Wi-Fi, use the computer's LAN address instead of `localhost`. Do not expose the development server publicly.

## Install the Android assistant

Download the APK from the [latest release](https://github.com/zaf-07/GuideBand/releases/latest), or build it locally (below).

After sideloading it:

1. Open GuideBand and tap **Choose GuideBand as assistant**. Accept the Android assistant-role prompt.
2. Tap **Enable phone control** and explicitly enable GuideBand under Accessibility. The service does not passively store screen contents.
3. Tap **Allow notifications**, then **Start voice assistant** while the activity is visible.
4. Keep the persistent "GuideBand is active" notification. Its Stop action immediately ends microphone capture.
5. Say "Guide, open YouTube", "Guide, set a timer for 10 minutes", "Guide, search for coffee nearby", or "Guide, let's walk to Safeway".

Calls, WhatsApp and journey sharing are treated as consequential and show a confirmation screen. Android still owns the final call/send action. The demo recognizer is a software foreground listener; unlike Google Assistant's privileged DSP hotword path it consumes more battery and availability depends on the device speech-recognition service.

Build locally with JDK 17 and Android SDK 35:

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

The release workflow publishes an Android APK, macOS DMG/ZIP, Windows EXE, Linux AppImage/DEB, and the web app on GitHub Pages.

## Vexo Band

The supplied unit enumerates as `Vexo Open band` at `/dev/cu.usbmodem1101` (USB VID `0x2FE3`, PID `0x0004`). Re-check instead of hard-coding the path:

```bash
python3 scripts/vexo_probe.py
```

Vexo's public developer API currently exposes read-only memory over OAuth MCP. Public live-audio and haptic-write documentation was not found, so the adapter marks them `unverified`. The phone is the guaranteed demo fallback until the hackathon SDK is supplied.

For the demo today, pair the Band with Vexo's Android app over Bluetooth using Vexo's normal onboarding. GuideBand itself must not claim the Band microphone or vibration channel until Vexo provides the hackathon SDK/protocol. Once provided, it plugs into the isolated wearable adapter; commands, confirmations and phone automation do not need to change. USB currently confirms hardware presence and offers a serial interface, but its audio/haptic framing is undocumented, so GuideBand deliberately does not write arbitrary bytes to it.

## Android reality check

A normal APK with broad permissions cannot silently control every app. Android intents can open calls, maps and WhatsApp. Reading arbitrary chats requires app-supported APIs, user interaction or an explicitly enabled `AccessibilityService`; the latter is privacy-sensitive, brittle and subject to store policy. The MVP previews and confirms every outward action.

## Safety and privacy

- An assistive companion, not a replacement for a white cane, guide dog or orientation training.
- No raw video or audio is stored.
- Low-confidence results are flagged instead of stated as fact.
- Money never moves without a spoken yes; payments run in Stripe test mode.
- Object detection is not distance measurement: GuideBand says where something is in view, not how far away it is.

## Test

```bash
python3 -m unittest discover -s backend/tests -v
python3 scripts/vexo_probe.py --json
```

## Sources

[Vexo developer docs](https://www.vexoai.com/docs), [Vexo hardware overview](https://www.vexoai.com/), [Android common intents](https://developer.android.com/guide/components/intents-common), [Android accessibility services](https://developer.android.com/guide/topics/ui/accessibility/service).

MIT licensed.
