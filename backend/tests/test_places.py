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

    def test_misheard_names_still_reach_the_right_contact(self):
        self.memory.add_contact('Tim', '+14155550100')
        self.memory.add_contact('Zack', '+14155550101')
        self.assertEqual(self.memory.find_contact('tell my team where I am')['name'], 'Tim')
        self.assertEqual(self.memory.find_contact('text zach saying hello')['name'], 'Zack')
        self.assertEqual(self.memory.find_contact('Tell Tim I am late')['name'], 'Tim')
        self.assertIsNone(self.memory.find_contact('read the text you can see'))
        self.assertIsNone(self.memory.find_contact('what is in front of me'))

    def test_loose_phrasing_through_a_noisy_microphone(self):
        self.memory.add_contact('Tim', '+14155550100')
        draft = run(self.assistant.respond('s', 'Hell, my team friend. My friend teams. Tell my team where I am', location=HERE))
        self.assertEqual(draft['intent'], 'message')
        self.assertEqual(draft['confirm'], 'Send to Tim on WhatsApp?')
        self.assertEqual(run(self.assistant.respond('s', 'No'))['intent'], 'message_cancel')
        self.assertEqual(run(self.assistant.respond('s', 'Read the text you can see'))['intent'], 'see')

    def test_unknown_person_lists_the_contacts(self):
        self.memory.add_contact('Tim', '+14155550100')
        reply = run(self.assistant.respond('s', 'Tell Barbara where I am', location=HERE))
        self.assertIn('Your contacts are Tim.', reply['say'])

    def test_more_ways_to_say_it(self):
        self.assertEqual(route('Can you change my home address to San Francisco Bay University?'), 'place_set')
        self.assertEqual(route('Set my work address to 1 Market Street San Francisco'), 'place_set')
        self.assertEqual(route('I live at 161 Mission Falls Lane Fremont'), 'place_set')
        self.assertEqual(route('Update my home to 12 Oak Street'), 'place_set')
        saved = run(self.assistant.respond('s', 'Can you change my home address to San Francisco Bay University?'))
        self.assertIn('Saved. Your home is', saved['say'])
        self.assertIsNotNone(self.memory.place('home'))
        run(self.assistant.respond('s', 'Set my work address to 1 Market Street San Francisco'))
        self.assertIsNotNone(self.memory.place('work'))

    def test_a_name_the_map_gets_wrong_is_looked_up_as_an_address(self):
        calls = []

        async def map_search(text, lat=None, lon=None):
            calls.append(text)
            if 'Mission Falls' in text:
                return {'label': '161, Mission Falls Lane, Fremont', 'lat': 37.4845, 'lon': -121.9273}
            return {'label': 'UCSF Mission Bay, Nelson Rising Lane', 'lat': 37.7687, 'lon': -122.3922}  # sounds alike, wrong

        async def lookup(place):
            return '161 Mission Falls Lane, Fremont, CA'

        assistant = Assistant(self.memory, Orders(), geocode=map_search, lookup_address=lookup)
        saved = run(assistant.respond('s', 'Change my home address to San Francisco Bay University'))
        self.assertIn('San Francisco Bay University (161, Mission Falls Lane, Fremont)', saved['say'])
        self.assertAlmostEqual(self.memory.place('home')['lat'], 37.4845)
        # A real street address is trusted as it is, with no second lookup.
        calls.clear()
        run(assistant.respond('s', 'My home address is 161 Mission Falls Lane Fremont'))
        self.assertEqual(len(calls), 1)

    def test_places_survive_erasing_memory(self):
        self.memory.save_place('home', 'Somewhere', 1.0, 2.0)
        self.memory.clear()
        self.assertEqual(len(self.memory.places()), 1)
        self.memory.remove_place('home')
        self.assertEqual(self.memory.places(), [])


if __name__ == '__main__':
    unittest.main()
