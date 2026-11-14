"""Sending a WhatsApp message for the user.

With Twilio credentials the message is delivered by the service itself, with no
further tap. Without them the caller falls back to opening WhatsApp with the
text prepared. Either way the assistant only calls this after a spoken yes.
"""
from __future__ import annotations

import os

SANDBOX_NUMBER = '+14155238886'  # Twilio's shared WhatsApp sandbox sender


class MessageError(Exception):
    pass


def configured() -> bool:
    return bool(os.getenv('TWILIO_ACCOUNT_SID') and os.getenv('TWILIO_AUTH_TOKEN'))


async def send_whatsapp(phone: str, text: str) -> dict:
    """Deliver `text` to `phone` (digits with country code). Raises MessageError on failure."""
    import httpx
    sid, token = os.environ['TWILIO_ACCOUNT_SID'], os.environ['TWILIO_AUTH_TOKEN']
    sender = os.getenv('TWILIO_WHATSAPP_FROM', SANDBOX_NUMBER)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
            response = await client.post(
                f'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json',
                auth=(sid, token),
                data={'From': f'whatsapp:{sender}', 'To': f'whatsapp:+{phone}', 'Body': text[:1500]},
            )
    except Exception as error:
        raise MessageError('I could not reach the message service.') from error
    if response.status_code >= 400:
        raise MessageError('The message service refused the message.')
    return {'id': response.json().get('sid'), 'status': response.json().get('status')}
