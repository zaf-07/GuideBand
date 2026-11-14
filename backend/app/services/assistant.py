"""The GuideBand assistant: one spoken sentence in, one spoken reply out.

`route` decides what the user wants with plain rules, so the safety-relevant
decisions (is this a payment? was that a yes?) never depend on a language model.
`Assistant.respond` then runs the matching tool: see, recall, remember or pay.
"""
from __future__ import annotations

import re

from . import navigation, vision
from .memory import Memory
from .payments import Orders, PaymentError

YES = re.compile(r"^\W*(yes|yeah|yep|yup|sure|confirm|go ahead|do it|pay( it| now)?|okay|ok)\b")
NO = re.compile(r"^\W*(no|nope|cancel|stop|not now|never mind|don't|do not)\b")
FORGET = re.compile(r'\b(forget everything|(clear|delete|wipe|erase) (all )?(my |your )?memor(y|ies))\b')
REMEMBER = re.compile(r'^\W*(please )?remember\b|\bsave this\b|\bremember (this|that|where)\b')
PAY = re.compile(r'\b(buy|order|purchase|pay for|get me)\b')
RECALL = re.compile(
    r'\bwhere (did|have)\b|\bwhere (is|are|was|were) my\b|\bwhat did\b|\b(did|have) you seen?\b'
    r'|\bdo you remember\b|\blast (saw|seen)\b|\bwhat (do|did) you remember\b'
)
BRIDGE = re.compile(r'\bbridge\b')
NAV = re.compile(
    r'\b(take|guide|walk|navigate|lead|bring|get) me to\b|\b(directions?|route|way) to\b'
    r'|\bhow do i get to\b|\bnavigate to\b|\b(nearest|closest)\b'
)
NAV_STOP = re.compile(r'\b(stop|cancel|end) (the )?(navigation|directions|route|guiding)\b')
GO_BACK = re.compile(r'\b(take|guide|walk|lead|bring) me back\b|\bway back\b|\bgo back to (the )?start\b')
HELP = re.compile(r'\bwhat can you do\b|^\W*help\b')

HELP_TEXT = (
    'I can tell you what is in front of you, read text, remember where things are, '
    'guide you on foot to a place nearby, and buy something after you say yes. Try: what is in front of me?'
)


def route(text: str, has_pending_order: bool = False) -> str:
    value = text.lower().strip()
    if has_pending_order:
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
    if NAV.search(value):
        return 'navigate'
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
    if YES.search(value) or NO.search(value):
        return 'nothing_pending'
    return 'see'


class Assistant:
    def __init__(self, memory: Memory, orders: Orders, detector=None, navigator=None, place_name=None) -> None:
        self.navigator = navigator or navigation.Navigator()
        self.place_name = place_name or navigation.place_name
        self.memory = memory
        self.orders = orders
        self.detector = detector or vision.detector

    async def respond(self, session: str, text: str, image: bytes | None = None, mime: str = 'image/jpeg',
                      location: tuple[float, float] | None = None) -> dict:
        pending = self.orders.pending(session)
        intent = route(text, bool(pending))
        reply = {'intent': intent, 'heard': text, 'say': '', 'order': None, 'warnings': [], 'detections': [], 'provider': None}

        if intent == 'pay_quote':
            order = self.orders.quote(session, text)
            if order is None:
                reply['say'] = 'I could not find a price for that, so I will not pay for it.'
            else:
                reply['order'] = order
                reply['say'] = f'One {order["item"]} for {order["price"]}. Say yes to pay, or no to cancel.'
        elif intent == 'pay_confirm':
            try:
                receipt = await self.orders.confirm(session)
                reply['order'] = receipt
                note = ' This was a simulated payment.' if receipt['mode'] == 'simulated' else ' Paid in Stripe test mode.'
                reply['say'] = f'Done. I paid {receipt["price"]} for one {receipt["item"]}.{note}'
                self.memory.add_note('purchase', f'Bought one {receipt["item"]} for {receipt["price"]}.')
            except PaymentError as error:
                reply['say'] = str(error)
        elif intent == 'pay_cancel':
            self.orders.cancel(session)
            reply['say'] = 'Cancelled. Nothing was paid.'
        elif intent == 'pay_waiting':
            reply['order'] = pending
            reply['say'] = f'I am waiting for a yes or no: one {pending["item"]} for {pending["price"]}.'
        elif intent == 'nothing_pending':
            reply['say'] = 'There is nothing waiting for your answer.'
        elif intent == 'forget':
            self.memory.clear()
            reply['say'] = 'Done. I have erased everything I remembered.'
        elif intent == 'recall':
            answer = await self.memory.recall(text)
            reply.update(say=answer['text'], provider=answer['provider'])
        elif intent == 'nav_stop':
            reply['say'] = 'Navigation stopped.' if self.navigator.stop(session) else 'No navigation is running.'
        elif intent in ('navigate', 'go_back'):
            reply['say'] = await self._navigate(session, intent, text, location)
            reply['navigating'] = self.navigator.active(session) is not None
        elif intent == 'bridge':
            reply['say'] = 'Bridge mode is on. Speech will appear as large captions, and I will speak what you type.'
        elif intent == 'help':
            reply['say'] = HELP_TEXT
        elif image is None:
            reply['say'] = 'I need the camera for that. Please turn the camera on.'
        else:
            place = await self.place_name(*location) if location else ''
            await self._look(reply, intent, text, image, mime, place)
        return reply

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
        answer = await vision.describe(image, mime, text, detections)
        reply.update(say=answer['text'], provider=answer['provider'])
        if answer['provider'] != 'local':
            self.memory.add_note('seen', f'Asked "{text}". Answer: {answer["text"]}', place=place)
