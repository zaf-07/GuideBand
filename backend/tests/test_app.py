import unittest
from backend.app.planner import plan
from backend.app.services.wearable import status

class GuideBandTests(unittest.TestCase):
    def test_journey_requires_confirmation(self):
        result=plan('In 30 minutes help me walk to Safeway');self.assertEqual(result['intent'],'schedule_journey');self.assertTrue(result['requires_confirmation']);self.assertEqual(result['delay_minutes'],30)
    def test_external_actions_require_confirmation(self):
        self.assertTrue(plan('call Alex')['requires_confirmation']);self.assertTrue(plan('read WhatsApp')['requires_confirmation'])
    def test_unknown_is_safe(self): self.assertEqual(plan('do anything')['intent'],'unknown')
    def test_capabilities_are_explicit(self):
        caps={item['name']:item['status'] for item in status()['capabilities']};self.assertEqual(caps['live_audio'],'unverified');self.assertEqual(caps['haptics_write'],'unverified')

if __name__=='__main__': unittest.main()
