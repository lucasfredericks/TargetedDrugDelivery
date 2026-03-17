"""Software (bit-bang) SPI using gpiozero.

Drop-in replacement for spidev.SpiDev when hardware SPI doesn't work.
Only implements the subset of methods used by the MFRC522 library.

Usage:
    from soft_spi import SoftSPI
    spi = SoftSPI(cs=8, sck=11, mosi=10, miso=9)
    response = spi.xfer2([0xEE, 0x00])
    spi.close()
"""

import time
from gpiozero import OutputDevice, InputDevice


class SoftSPI:
    """Bit-bang SPI master using gpiozero GPIO pins."""

    def __init__(self, cs, sck, mosi, miso, speed=50000):
        """Initialize with GPIO pin numbers (BCM).

        Args:
            cs:    Chip select GPIO (active low)
            sck:   Clock GPIO
            mosi:  Master Out Slave In GPIO
            miso:  Master In Slave Out GPIO
            speed: Approximate clock speed in Hz (default 50kHz)
        """
        self._cs = OutputDevice(cs, initial_value=True)
        self._sck = OutputDevice(sck, initial_value=False)
        self._mosi = OutputDevice(mosi, initial_value=False)
        self._miso = InputDevice(miso)
        self._half_period = 1.0 / (2 * speed) if speed > 0 else 0.001
        self._max_speed_hz = speed

    @property
    def max_speed_hz(self):
        return self._max_speed_hz

    @max_speed_hz.setter
    def max_speed_hz(self, value):
        self._max_speed_hz = value
        self._half_period = 1.0 / (2 * value) if value > 0 else 0.001

    @property
    def mode(self):
        return 0

    @mode.setter
    def mode(self, value):
        pass  # Only SPI mode 0 supported (CPOL=0, CPHA=0)

    def open(self, bus, device):
        """No-op for API compatibility with spidev.SpiDev."""
        pass

    def xfer2(self, data):
        """Transfer data (full-duplex). Returns list of received bytes.

        CS is held low for the entire transaction (no gaps between bytes).
        """
        result = []
        self._cs.off()
        time.sleep(self._half_period)

        for byte_out in data:
            byte_in = 0
            for i in range(8):
                # Set MOSI
                if byte_out & (0x80 >> i):
                    self._mosi.on()
                else:
                    self._mosi.off()
                time.sleep(self._half_period)

                # Rising edge — sample MISO
                self._sck.on()
                time.sleep(self._half_period)
                if self._miso.is_active:
                    byte_in |= (0x80 >> i)

                # Falling edge
                self._sck.off()

            result.append(byte_in)

        self._cs.on()
        return result

    def close(self):
        """Release GPIO resources."""
        for dev in (self._cs, self._sck, self._mosi, self._miso):
            try:
                dev.close()
            except Exception:
                pass
