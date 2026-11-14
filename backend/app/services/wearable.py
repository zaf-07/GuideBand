from dataclasses import asdict, dataclass
from glob import glob

@dataclass(frozen=True)
class Capability:
    name: str
    status: str
    evidence: str

def serial_ports() -> list[str]:
    return sorted(glob('/dev/cu.usbmodem*') + glob('/dev/ttyACM*'))

def status() -> dict:
    ports = serial_ports()
    capabilities = [
        Capability('usb_presence', 'detected' if ports else 'unavailable', ports[0] if ports else 'No serial device detected'),
        Capability('memory_api', 'documented', 'Vexo OAuth MCP is read-only'),
        Capability('live_audio', 'unverified', 'No public live-audio SDK found'),
        Capability('haptics_write', 'unverified', 'Hardware has haptics; no public write API found'),
    ]
    return {'connected': bool(ports), 'ports': ports, 'capabilities': [asdict(item) for item in capabilities]}
