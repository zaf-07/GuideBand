# GuideBand

GuideBand is a voice-first accessibility layer for blind and low-vision people. It turns a phone and a Vexo Band into one calm, screen-optional assistant for planning, getting around, communicating, remembering and staying connected with trusted people.

> Prototype assistive technology. GuideBand is not a replacement for a white cane, guide dog, orientation and mobility training, emergency services or verified navigation instructions.

## First version

- Completely new, high-contrast installable mobile PWA.
- Wake phrase concept: **“Guide, I’m ready.”** Hold-to-talk is the reliable fallback.
- Reminders, walking-direction links, calls and WhatsApp with spoken confirmation.
- Journey mode that keeps route steps separate from unverified camera notices.
- Consent-based Guardian sharing with a visible state.
- Bridge mode for large captions and phrase-to-speech communication.
- FastAPI command/task/event service and a read-only Vexo USB probe.

## Run

```bash
python3 -m http.server 4173 --directory web
```

Open `http://localhost:4173`. On Android Chrome, choose **Add to Home screen**. Speech recognition works best over HTTPS or localhost; touch controls remain available.

Optional API:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

For a phone on the same Wi-Fi, use the Mac's LAN address instead of `localhost`. Do not expose the development server publicly.

## Install the Android assistant

An installable hackathon build is available at [output/android/GuideBand-Android-debug.apk](output/android/GuideBand-Android-debug.apk).

After sideloading it:

1. Open GuideBand and tap **Choose GuideBand as assistant**. Accept the Android assistant-role prompt.
2. Tap **Enable phone control** and explicitly enable GuideBand under Accessibility. The service does not passively store screen contents.
3. Tap **Allow notifications**, then **Start voice assistant** while the activity is visible.
4. Keep the persistent “GuideBand is active” notification. Its Stop action immediately ends microphone capture.
5. Say “Guide, open YouTube”, “Guide, set a timer for 10 minutes”, “Guide, search for coffee nearby”, or “Guide, let’s walk to Safeway”.

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

## Test

```bash
python3 -m unittest discover -s backend/tests -v
python3 scripts/vexo_probe.py --json
```

## Prior work disclosure

The concept builds on lessons from [GuideLens](https://github.com/k1lst1x/nvidia-dgx-spark-hackathon-2026), a previous accessibility prototype. GuideBand's identity, interaction model, interface and wearable/phone workflow were created for VexoHacks 2026. No SFBU or NVIDIA branding is used in this product.

Sources: [Vexo developer docs](https://www.vexoai.com/docs), [Vexo hardware overview](https://www.vexoai.com/), [Android common intents](https://developer.android.com/guide/components/intents-common), [Android accessibility services](https://developer.android.com/guide/topics/ui/accessibility/service).

MIT licensed.
