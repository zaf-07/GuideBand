from __future__ import annotations

from dataclasses import asdict, dataclass
from glob import glob
import json
import subprocess

from .vexo_config import BAND_NAME, BAND_NUMBER, SERVICE_UUID

@dataclass(frozen=True)
class Capability:
    name: str
    status: str
    evidence: str

def serial_ports() -> list[str]:
    return sorted(
        glob('/dev/cu.usbmodem*')
        + glob('/dev/tty.usbmodem*')
        + glob('/dev/ttyACM*')
    )

def bluetooth_devices() -> list[dict[str, str | None]]:
    """Return connected Vexo BLE devices without opening a BLE session."""
    try:
        completed = subprocess.run(
            ['system_profiler', 'SPBluetoothDataType', '-json', '-detailLevel', 'full'],
            capture_output=True, text=True, timeout=8, check=False,
        )
        reports = json.loads(completed.stdout).get('SPBluetoothDataType', [])
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError, AttributeError):
        return []

    devices = []
    for report in reports:
        for entry in report.get('device_connected', []):
            for name, details in entry.items():
                if name == BAND_NAME:
                    devices.append({'name': name, 'address': details.get('device_address')})
    return devices

def status() -> dict:
    ports = serial_ports()
    bluetooth = bluetooth_devices()
    capabilities = [
        Capability('usb_presence', 'detected' if ports else 'unavailable', ports[0] if ports else 'No serial device detected'),
        Capability('bluetooth_presence', 'detected' if bluetooth else 'unavailable', bluetooth[0]['name'] if bluetooth else 'No connected Vexo BLE device detected'),
        Capability('identity', 'locked', f'Only {BAND_NAME}; service {SERVICE_UUID}'),
        Capability('live_audio', 'documented', 'Opus 16 kHz mono, 20 ms frames over the Vexo Open contract'),
        Capability('deepgram', 'ready', 'Official helper reads DEEPGRAM_API_KEY; mip_opt_out=true'),
        Capability('band_haptics', 'unavailable', 'Vexo Open contract explicitly says this hardware has no vibration'),
        Capability('phone_haptics', 'implemented', 'Android vibrates after every accepted GuideBand command'),
    ]
    return {
        'connected': bool(ports or bluetooth),
        'band_number': BAND_NUMBER,
        'band_name': BAND_NAME,
        'service_uuid': SERVICE_UUID,
        'ports': ports,
        'bluetooth_devices': bluetooth,
        'capabilities': [asdict(item) for item in capabilities],
    }
