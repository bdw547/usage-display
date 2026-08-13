# Flashing from WSL2

The board's USB-C is a CH340 UART bridge (shows on Windows as "USB-SERIAL CH340").

## One-time setup (Windows side, admin PowerShell)
1. `winget install usbipd` (or download usbipd-win from GitHub)
2. Plug in the display, then: `usbipd list` → note the BUSID of the CH340 / USB Serial device
3. `usbipd bind --busid <BUSID>`   ← admin needed once

## Every plug-in (from WSL — Windows exes are callable here)
    usbipd.exe attach --wsl --busid <BUSID>
    ls /dev/ttyUSB* /dev/ttyACM*      # device appears as /dev/ttyUSB0 (CH340) within ~2s

If permission denied: `sudo usermod -aG dialout $USER` then re-open the shell.

## Flash + monitor
    cd firmware
    pio run -t upload            # auto-detects the port
    pio device monitor           # 115200 baud; Ctrl+] to exit

If upload fails to sync: hold BOOT, tap RST, release BOOT, retry upload (rarely needed — the
CH340 auto-reset circuit usually handles it). Fallback: build here, flash from Windows with
esptool: `pio run` then use .pio/build/guition4848s040/firmware.bin @ 0x10000, bootloader.bin
@ 0x0, partitions.bin @ 0x8000.
