# GuideBand product and research brief

## Product decision

The strongest story is not “voice control for every Android button.” It is one accessible trust layer between a person, wearable and phone: **hear → understand → preview → confirm → act → acknowledge**. The unique feature is Bridge: the same loop works across disability boundaries through captions, speech and later a deliberately limited, validated sign vocabulary.

Recommended wake phrase: **“Guide, I’m ready.”** It is short, brand-linked and does not imply emergency reliability. Push-to-talk remains available because always-on wake-word processing needs battery, privacy and false-activation testing.

## Vexo capability matrix (14 Nov 2026)

| Capability | Status | Evidence / decision |
|---|---|---|
| Built-in microphone | Confirmed product capability | Vexo says Band audio reaches its phone app over Bluetooth. Use only through the supplied SDK. |
| Quiet haptics | Confirmed hardware capability | Product specifications confirm haptics; public write API was not found. |
| USB connection | Confirmed on supplied unit | macOS enumerates `Vexo Open band`, VID `0x2FE3`, PID `0x0004`. Probe is read-only. |
| Read Vexo memories | Publicly documented | OAuth 2.1 MCP, `vexo:read`, read-only. Useful for recall, not live control. |
| Live audio SDK | Not publicly confirmed | Ask Vexo staff for hackathon SDK/examples. Phone mic is the fallback. |
| Haptic write SDK | Not publicly confirmed | Keep a wearable adapter boundary; phone vibration/audio are fallback outputs. |

## Android feasibility

- Maps: use a Google Maps directions intent. The user remains in control.
- Calls: `ACTION_DIAL` is safer than direct calling because it leaves the final action to the user.
- WhatsApp: deep-link to a contact or prefilled message. Reading all chats is not a general Android permission; it needs WhatsApp support, notification access for future notifications, or AccessibilityService automation.
- Full phone control is possible only in bounded form. An AccessibilityService can observe UI and perform gestures after explicit user enablement, but it is sensitive, brittle and subject to Google Play policy. Use an allowlist, visible state, local audit log, confirmation for consequential actions and an immediate stop control.
- Tracking: background location needs explicit consent, an ongoing notification and secure authenticated sharing. It must be trip-scoped, revocable and never covert.

## Demo flow

1. “Guide, I’m ready. In 30 minutes help me walk to Safeway.”
2. GuideBand repeats the plan and asks for confirmation.
3. At the due time it announces readiness and asks before opening walking directions.
4. Journey mode speaks Maps route instructions and labels separate camera observations as unverified. It never invents distance.
5. A trusted contact can follow only after the user enables Guardian for this trip.
6. In Bridge, another person's speech becomes large text; the user dictates a phrase and the phone speaks it.

## Next slices

1. Obtain the Vexo hackathon SDK and replace each `unverified` capability with a reproducible hardware test.
2. Wrap the PWA as a Trusted Web Activity or move the shell native for intents, foreground location and camera.
3. Add local wake-word detection with an explicit listening indicator and measured false-positive rate.
4. Add on-device object detection from the prior core behind the new event contract; keep routing and vision warnings independent.
5. Add an allowlisted AccessibilityService only for judge-visible scenarios, with a persistent notification and confirmation gate.
6. Extend Bridge with MediaPipe landmarks and a signer-validated phrase vocabulary. Never claim universal ASL translation.
