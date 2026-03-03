"""GPIO button input handler for physical exhibit buttons.

Provides debounced button press callbacks for:
  - Scan Nanoparticle (read color sensors)
  - Start Test (begin simulation)
  - Reset (return to idle)
"""

import logging
import RPi.GPIO as GPIO

from config import (
    GPIO_BUTTON_SCAN, GPIO_BUTTON_TEST, GPIO_BUTTON_RESET, GPIO_DEBOUNCE_MS
)

logger = logging.getLogger(__name__)


class GPIOInput:
    """Manages physical button inputs via Raspberry Pi GPIO."""

    def __init__(self):
        self._callbacks = {
            "scan": None,
            "test": None,
            "reset": None
        }

    def initialize(self):
        """Set up GPIO pins with pull-up resistors and edge detection."""
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)

        pins = {
            GPIO_BUTTON_SCAN: "scan",
            GPIO_BUTTON_TEST: "test",
            GPIO_BUTTON_RESET: "reset",
        }

        for pin, name in pins.items():
            GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
            GPIO.add_event_detect(
                pin, GPIO.FALLING,
                callback=lambda ch, n=name: self._on_press(n),
                bouncetime=GPIO_DEBOUNCE_MS
            )
            logger.info("GPIO pin %d configured for '%s' button", pin, name)

    def on_scan(self, callback):
        """Register callback for scan button press."""
        self._callbacks["scan"] = callback

    def on_test(self, callback):
        """Register callback for test button press."""
        self._callbacks["test"] = callback

    def on_reset(self, callback):
        """Register callback for reset button press."""
        self._callbacks["reset"] = callback

    def _on_press(self, button_name):
        logger.info("Button pressed: %s", button_name)
        cb = self._callbacks.get(button_name)
        if cb:
            try:
                cb()
            except Exception as e:
                logger.error("Button callback error (%s): %s", button_name, e)

    def cleanup(self):
        """Release GPIO resources."""
        GPIO.cleanup()
