#!/usr/bin/env python3
import argparse,json,subprocess
from pathlib import Path

def probe():
    paths=sorted(str(p) for pattern in ('cu.usbmodem*','tty.usbmodem*') for p in Path('/dev').glob(pattern));detail=''
    try: detail=subprocess.run(['ioreg','-p','IOUSB','-l','-w','0'],capture_output=True,text=True,timeout=5).stdout
    except (FileNotFoundError,subprocess.TimeoutExpired): pass
    found=bool(paths or 'Vexo Open band' in detail)
    return {'detected':found,'product':'Vexo Open band' if 'Vexo Open band' in detail else None,'serial_ports':paths,'vid':'0x2FE3' if found else None,'pid':'0x0004' if found else None,'note':'Presence only. Audio and haptic protocols require the official Vexo hackathon SDK.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Detect a connected Vexo Open Band without writing to it.');parser.add_argument('--json',action='store_true');args=parser.parse_args();result=probe();print(json.dumps(result,indent=2) if args.json else ('Vexo detected: '+str(result['detected'])+'\nPorts: '+(', '.join(result['serial_ports']) or 'none')+'\n'+result['note']))
