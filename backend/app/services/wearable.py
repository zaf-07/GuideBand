from __future__ import annotations

import sys
from dataclasses import asdict, dataclass
from glob import glob

VEXO_USB_ID = 'VID_2FE3&PID_0004'  # the Vexo Open band


@dataclass(frozen=True)
class Capability:
    name: str
    status: str
    evidence: str


def _windows_ports() -> list[str]:
    """COM ports that belong to the band and are plugged in right now. Reads the registry only."""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DEVICEMAP\SERIALCOMM') as key:
            present = {winreg.EnumValue(key, i)[1] for i in range(winreg.QueryInfoKey(key)[1])}
    except OSError:
        return []
    found = set()
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Enum\USB') as usb:
            for i in range(winreg.QueryInfoKey(usb)[0]):
                device = winreg.EnumKey(usb, i)
                if not device.upper().startswith(VEXO_USB_ID):
                    continue
                with winreg.OpenKey(usb, device) as instances:
                    for j in range(winreg.QueryInfoKey(instances)[0]):
                        try:
                            with winreg.OpenKey(instances, winreg.EnumKey(instances, j) + r'\Device Parameters') as params:
                                port = winreg.QueryValueEx(params, 'PortName')[0]
                        except OSError:
                            continue
                        if port in present:
                            found.add(port)
    except OSError:
        pass
    return sorted(found)


def serial_ports() -> list[str]:
    if sys.platform == 'win32':
        return _windows_ports()
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
