"""The GuideBand assistant: one spoken sentence in, one spoken reply out.

`route` decides what the user wants with plain rules, so the safety-relevant
decisions (is this a payment? was that a yes?) never depend on a language model.
`Assistant.respond` then runs the matching tool: see, recall, remember, pay,
navigate or message.

Anything that leaves the device on the user's behalf — money or a message — is
first read back and held until the user answers yes.
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote

from . import checkout, messaging, navigation, vision
from .memory import Memory
from .payments import Orders, PaymentError

YES = re.compile(r"^\W*(yes|yeah|yep|yup|sure|confirm|go ahead|do it|send( it)?|pay( it| now)?|okay|ok)\b")
NO = re.compile(r"^\W*(no|nope|cancel|stop|not now|never mind|don't|do not)\b")
FORGET = re.compile(r'\b(forget everything|(clear|delete|wipe|erase) (all )?(my |your )?memor(y|ies))\b')
REMEMBER = re.compile(r'^\W*(please )?remember\b|\bsave this\b|\bremember (this|that|where)\b')
PAY = re.compile(r'\b(buy|order|purchase|pay for|get me)\b')
SCAN_PAY = re.compile(r'\b(pay|scan|buy)\b.*\b(this|that|it|code|qr|bill|total)\b|\bscan (and|to) pay\b|^\W*pay\W*$')
RECALL = re.compile(
    r'\bwhere (did|have)\b|\bwhere (is|are|was|were) my\b|\bwhat did\b|\b(did|have) you seen?\b'
    r'|\bdo you remember\b|\blast (saw|seen)\b|\bwhat (do|did) you remember\b'
    r'|\bwhere (was|have) i\b|\bwhere did i go\b|\bwhat (did|have) i (ask|asked|say|said)\b'
)
WHERE = re.compile(r"\bwhere am i\b|\bwhat(?:'s| is) (around|near|nearby)( me)?\b|\bmy (current )?location\b|\bwhat street\b")
MESSAGE = re.compile(r'^\W*(?:please )?(tell|text|message|whatsapp|send)\s+(?!me\b)|\bshare my location\b')
BRIDGE = re.compile(r'\bbridge\b')
NAV = re.compile(
    r'\b(take|guide|walk|navigate|lead|bring|get) me to\b|\b(directions?|route|way) to\b'
    r'|\bhow do i get to\b|\bnavigate to\b|\b(nearest|closest)\b'
)
NAV_STOP = re.compile(r'\b(stop|cancel|end) (the )?(navigation|directions|route|guiding)\b')
GO_BACK = re.compile(r'\b(take|guide|walk|lead|bring) me back\b|\bway back\b|\bgo back to (the )?start\b')
READ = re.compile(r'read|what does (it|that|this|the) .*say|what is written')
READ_QUESTION = (
    'Read aloud every piece of text you can see in this image, word for word, starting with the largest. '
    'Say only the text itself. If there is no readable text, say that you cannot see any text.'
)
HELP = re.compile(r'\bwhat can you do\b|^\W*help\b')
GREETING = re.compile(r'^\W*(hi|hello|hey|good (morning|afternoon|evening)|howdy)\b')

HELP_TEXT = (
    'I can tell you what is in front of you, read text, remember where things are, tell you where you are, '
    'guide you on foot to a place nearby, message your family, and pay after you say yes. '
    'Try: what is in front of me?'
)
MESSAGE_TTL_SECONDS = 60


def route(text: str, has_pending: bool = False) -> str:
    value = text.lower().strip()
    if has_pending:
        if YES.search(value):
            return 'pay_confirm'
        if NO.search(value):
            return 'pay_cancel'
        return 'pay_waiting'
    if FORGET.search(value):
        return 'forget'
    if NAV_STOP.search(value):
        return 'nav_stop'
    if GO_BACK.search(value):
        return 'go_back'
    if WHERE.search(value):
        return 'where_am_i'
    if MESSAGE.search(value):
        return 'message'
    if NAV.search(value):
        return 'navigate'
    if SCAN_PAY.search(value):
        return 'scan_pay'
    if PAY.search(value):
        return 'pay_quote'
    if RECALL.search(value):
        return 'recall'
    if REMEMBER.search(value):
        return 'remember'
    if BRIDGE.search(value):
        return 'bridge'
    if HELP.search(value):
        return 'help'
    if GREETING.search(value):
        return 'greeting'
    if YES.search(value) or NO.search(value):
        return 'nothing_pending'
    return 'see'


def message_body(text: str) -> str:
    """The words to send, when the user dictated them: '... saying I am running late'."""
    match = re.search(r'\b(?:saying|that says|say|that)\b[\s,:]*(.+)$', text, re.IGNORECASE)
    body = match.group(1).strip(' .') if match else ''
    return '' if re.search(r'\bwhere i am\b|\bmy location\b', body, re.IGNORECASE) else body


class Assistant:
    def __init__(self, memory: Memory, orders: Orders, detector=None, navigator=None, place_name=None,
                 read_frame=None, send_whatsapp=None, send_desktop=None) -> None:
        self.send_whatsapp = send_whatsapp or messaging.send_whatsapp
        self.send_desktop = send_desktop or messaging.send_desktop
        self.navigator = navigator or navigation.Navigator()
        self.place_name = place_name or navigation.place_name
        self.read_frame = read_frame or checkout.read_frame
        self.memory = memory
        self.orders = orders
        self.detector = detector or vision.detector
        self._messages: dict[str, dict] = {}

    def pending_message(self, session: str) -> dict | None:
        message = self._messages.get(session)
        if message and time.time() > message['expires']:
            del self._messages[session]
            return None
        return message

    async def respond(self, session: str, text: str, image: bytes | None = None, mime: str = 'image/jpeg',
                      location: tuple[float, float] | None = None) -> dict:
        order = self.orders.pending(session)
        message = self.pending_message(session)
        intent = route(text, bool(order or message))
        if message and not order:
            intent = intent.replace('pay_', 'message_')
        reply = {'intent': intent, 'heard': text, 'say': '', 'order': None, 'confirm': None, 'open_url': None,
                 'warnings': [], 'detections': [], 'provider': None}
        if not intent.endswith(('_confirm', '_cancel', '_waiting')) and intent not in ('forget', 'nothing_pending', 'recall'):
            self.memory.add_note('asked', f'I asked: "{text}"')

        if intent == 'pay_quote':
            self._quote(reply, self.orders.quote(session, text))
        elif intent == 'scan_pay':
            await self._scan_pay(reply, session, image, mime)
        elif intent == 'pay_confirm':
            try:
                receipt = await self.orders.confirm(session)
                reply['order'] = receipt
                note = ' This was a simulated payment.' if receipt['mode'] == 'simulated' else ' Paid in Stripe test mode.'
                reply['say'] = f'Done. I paid {receipt["price"]} for {receipt["item"]}.{note}'
                self.memory.add_note('purchase', f'Bought {receipt["item"]} for {receipt["price"]}.')
            except PaymentError as error:
                reply['say'] = str(error)
        elif intent == 'pay_cancel':
            self.orders.cancel(session)
            reply['say'] = 'Cancelled. Nothing was paid.'
        elif intent == 'pay_waiting':
            reply['order'] = order
            reply['confirm'] = f'Pay {order["price"]} for {order["item"]}?'
            reply['say'] = f'I am waiting for a yes or no: {order["item"]} for {order["price"]}.'
        elif intent == 'message':
            await self._compose_message(reply, session, text, location)
        elif intent == 'message_confirm':
            del self._messages[session]
            await self._send_message(reply, message)
        elif intent == 'message_cancel':
            del self._messages[session]
            reply['say'] = 'Cancelled. Nothing was sent.'
        elif intent == 'message_waiting':
            reply['confirm'] = f'Send to {message["name"]} on WhatsApp?'
            reply['say'] = f'I am waiting for a yes or no on the message to {message["name"]}.'
        elif intent == 'nothing_pending':
            reply['say'] = 'There is nothing waiting for your answer.'
        elif intent == 'forget':
            self.memory.clear()
            reply['say'] = 'Done. I have erased everything I remembered.'
        elif intent == 'recall':
            answer = await self.memory.recall(text)
            reply.update(say=answer['text'], provider=answer['provider'])
        elif intent == 'where_am_i':
            await self._where(reply, image, mime, location)
        elif intent == 'nav_stop':
            reply['say'] = 'Navigation stopped.' if self.navigator.stop(session) else 'No navigation is running.'
        elif intent in ('navigate', 'go_back'):
            reply['say'] = await self._navigate(session, intent, text, location)
            reply['navigating'] = self.navigator.active(session) is not None
        elif intent == 'bridge':
            reply['say'] = 'Bridge is on. I will speak signs I can read, and show what you say as large text.'
        elif intent == 'help':
            reply['say'] = HELP_TEXT
        elif intent == 'greeting':
            reply['say'] = 'Hello! I am GuideBand. I can describe what is in front of you, navigate, read text, or remember your items.'
        elif image is None:
            reply['say'] = 'I need the camera for that. Please turn the camera on.'
        else:
            place = await self.place_name(*location) if location else ''
            await self._look(reply, intent, text, image, mime, place)
        return reply

    # ----- pay -----

    def _quote(self, reply: dict, order: dict | None) -> None:
        if order is None:
            reply['say'] = 'I could not find a price for that, so I will not pay for it.'
            return
        reply['order'] = order
        reply['confirm'] = f'Pay {order["price"]} for {order["item"]}?'
        reply['say'] = f'{order["item"].capitalize()} for {order["price"]}. Say yes to pay, or no to cancel.'

    async def _scan_pay(self, reply: dict, session: str, image: bytes | None, mime: str) -> None:
        if image is None:
            reply['say'] = 'I need the camera to read the price. Please turn the camera on.'
            return
        found = await self.read_frame(image, mime)
        if found is None:
            reply['say'] = 'I cannot read a payment code or a clear price. Hold it closer and try again. Nothing was paid.'
            return
        item, cents, source = found
        try:
            order = self.orders.quote_item(session, item, cents)
        except PaymentError as error:
            reply['say'] = str(error)
            return
        self._quote(reply, order)
        reply['say'] = ('I scanned a payment code. ' if source == 'qr' else 'I read the price. ') + reply['say']

    # ----- message -----

    async def _compose_message(self, reply: dict, session: str, text: str, location: tuple[float, float] | None) -> None:
        contact = self.memory.find_contact(text)
        if contact is None:
            reply['say'] = 'I do not have that person in your contacts. Add them in the Family tab first.'
            return
        body = message_body(text)
        if not body:
            if location is None:
                reply['say'] = 'I need your location to share it. Please turn location on.'
                return
            place = await self.place_name(*location)
            body = (f'I am near {place}. ' if place else 'Here is where I am. ') + \
                   f'Map: https://maps.google.com/?q={location[0]:.5f},{location[1]:.5f} (sent with GuideBand)'
        self._messages[session] = {
            'name': contact['name'], 'phone': contact['phone'], 'text': body, 'expires': time.time() + MESSAGE_TTL_SECONDS,
            'url': f'https://wa.me/{contact["phone"]}?text={quote(body)}',
        }
        reply['confirm'] = f'Send to {contact["name"]} on WhatsApp?'
        spoken = body.split(' Map:')[0]
        reply['say'] = f'Message to {contact["name"]}: {spoken} Say yes to send, or no to cancel.'

    async def _send_message(self, reply: dict, message: dict) -> None:
        """The user said yes. Deliver directly when a message service is set up; otherwise open WhatsApp."""
        if messaging.configured():
            try:
                await self.send_whatsapp(message['phone'], message['text'])
                reply['say'] = f'Sent to {message["name"]} on WhatsApp.'
                self.memory.add_note('message', f'Sent {message["name"]} a WhatsApp message: "{message["text"]}"')
                return
            except messaging.MessageError:
                pass  # fall back to the options below
        if messaging.desktop_enabled() and await self.send_desktop(message['phone'], message['text']):
            reply['say'] = f'Sent to {message["name"]} on WhatsApp.'
            self.memory.add_note('message', f'Sent {message["name"]} a WhatsApp message: "{message["text"]}"')
            return
        reply['open_url'] = message['url']
        reply['say'] = f'Your message to {message["name"]} is ready in WhatsApp.'
        self.memory.add_note('message', f'Prepared a WhatsApp message for {message["name"]}: "{message["text"]}"')

    # ----- where, navigate, look -----

    async def _where(self, reply: dict, image: bytes | None, mime: str, location: tuple[float, float] | None) -> None:
        parts = []
        if location is not None:
            address = await navigation.address(*location)
            parts.append(f'You are at {address}.' if address else 'I have your GPS position, but could not look up the address.')
        else:
            parts.append('I do not have your location. Turn location on for the address.')
        if image is not None:
            import asyncio
            detections = await asyncio.to_thread(self.detector.detect, image)
            answer = await vision.describe(image, mime, 'Briefly describe my surroundings: what kind of place is this and what is around me?', detections)
            parts.append(answer['text'])
            reply.update(detections=detections, provider=answer['provider'])
        reply['say'] = ' '.join(parts)
        if location is not None:
            self.memory.add_note('place', reply['say'])

    async def _navigate(self, session: str, intent: str, text: str, location: tuple[float, float] | None) -> str:
        if location is None:
            return 'I need your location for directions. Please turn location on.'
        try:
            if intent == 'go_back':
                start = self.memory.trip_start()
                if start is None or navigation.haversine(*location, start['lat'], start['lon']) < 40:
                    return 'You are still close to where you started.'
                return await self.navigator.start_to(session, 'your starting point', *location, start['lat'], start['lon'])
            return await self.navigator.start(session, text, *location)
        except navigation.NavigationError as error:
            return str(error)

    async def _look(self, reply: dict, intent: str, text: str, image: bytes, mime: str, place: str = '') -> None:
        import asyncio
        detections = await asyncio.to_thread(self.detector.detect, image)
        self.memory.record_detections(detections)
        reply['detections'] = detections
        reply['warnings'] = vision.hazard_warnings(detections)
        if intent == 'remember':
            note = await self.memory.snapshot(image, mime, vision.local_description(detections), place)
            reply.update(say=f'I will remember this. {note["text"]}', provider=note['provider'])
            return
        if READ.search(text.lower()):
            # Reading is a different job from describing: ask for the words only, with no object hints.
            answer = await vision.describe(image, mime, READ_QUESTION, [])
        else:
            answer = await vision.describe(image, mime, text, detections)
        reply.update(say=answer['text'], provider=answer['provider'])
        if answer['provider'] != 'local':
            self.memory.add_note('seen', f'Answer to "{text}": {answer["text"]}', place=place)
