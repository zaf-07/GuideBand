from __future__ import annotations

import asyncio
import os
import unittest
from unittest import mock

from backend.app.services.assistant import Assistant, route
from backend.app.services.memory import Memory
from backend.app.services.navigation import Navigator
from backend.app.services.payments import Orders

HERE = (37.7606, -122.3866)
HOME = {'label': 'San Francisco Bay University, Fremont', 'lat': 37.5483, 'lon': -121.9886}


def run(coroutine):
    return asyncio.run(coroutine)


async def geocode(text, lat=None, lon=None):
    return None if 'nowhere' in text.lower() else HOME


async def fake_place(term, lat, lon):
    return None


async def fake_route(lat, lon, dest_lat, dest_lon):
    return {'distance_m': 1000, 'duration_s': 720, 'steps': [
        {'say': 'Head south on 3rd Street for 500 feet.', 'lat': lat, 'lon': lon, 'distance_m': 1000},
        {'say': 'You have arrived.', 'lat': dest_lat, 'lon': dest_lon, 'distance_m': 0},
    ]}


class PlaceTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {'GEMINI_API_KEY': '', 'GROQ_API_KEY': '', 'MINIMAX_API_KEY': ''})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.memory = Memory(':memory:')
        self.assistant = Assistant(self.memory, Orders(), navigator=Navigator(fake_place, fake_route), geocode=geocode)

    def test_routing(self):
        self.assertEqual(route('My home address is San Francisco Bay University'), 'place_set')
        self.assertEqual(route('Take me home'), 'place_go')
        self.assertEqual(route('Get directions home, please'), 'place_go')
        self.assertEqual(route('Take me to the nearest supermarket'), 'navigate')
        self.assertEqual(route('Write to Tom saying I am late'), 'message')
        self.assertEqual(route('Send a message to Tom saying hello'), 'message')
        self.assertEqual(route('Tell me what is in front of me'), 'see')

    def test_home_must_be_set_first(self):
        self.assertIn('do not know your home address', run(self.assistant.respond('s', 'Take me home', location=HERE))['say'])

    def test_set_home_then_go(self):
        saved = run(self.assistant.respond('s', 'My home address is San Francisco Bay University', location=HERE))
        self.assertIn('Saved. Your home is San Francisco Bay University, Fremont', saved['say'])
        self.assertEqual(self.memory.place('home')['lat'], HOME['lat'])
        self.assertIn('need your location', run(self.assistant.respond('s', 'Take me home'))['say'])
        going = run(self.assistant.respond('s', 'Get directions home, please', location=HERE))
        self.assertTrue(going['navigating'])
        self.assertIn('Your home is', going['say'])

    def test_unknown_address_is_not_saved(self):
        reply = run(self.assistant.respond('s', 'My home address is nowhere street 99999'))
        self.assertIn('could not find', reply['say'])
        self.assertIsNone(self.memory.place('home'))

    def test_places_survive_erasing_memory(self):
        self.memory.save_place('home', 'Somewhere', 1.0, 2.0)
        self.memory.clear()
        self.assertEqual(len(self.memory.places()), 1)
        self.memory.remove_place('home')
        self.assertEqual(self.memory.places(), [])


if __name__ == '__main__':
    unittest.main()
