Raspberry Pi Setup Instructions
================================

This guide covers setting up a Raspberry Pi as the master controller for the
Targeted Drug Delivery exhibit. The Pi reads physical inputs (color sensors,
RFID tags, buttons), coordinates simulation clients over the network, and
displays results on an attached monitor.


Prerequisites
-------------

Hardware:
- Raspberry Pi 4 (or 5) with Raspberry Pi OS (Bookworm or later)
- MicroSD card (16 GB minimum)
- Power supply (USB-C, 5V 3A)
- HDMI cable + monitor (for results display)
- Ethernet cable + unmanaged switch (for client network)
- TCA9548A I2C multiplexer breakout
- 6x Adafruit APDS-9960 color/proximity sensor breakouts
- MFRC522 RFID reader module + RFID tags (NTAG213 or Mifare Classic)
- 3x momentary push buttons (normally open)
- Jumper wires, breadboard or perfboard

Software:
- Python 3.9 or later (pre-installed on Raspberry Pi OS)
- pip (pre-installed)


Step 1: Enable I2C and SPI
---------------------------

Open the Raspberry Pi configuration tool:

    sudo raspi-config

Navigate to Interface Options and enable:
- I2C (for color sensors via TCA9548A)
- SPI (for MFRC522 RFID reader)

Reboot after enabling:

    sudo reboot

Verify I2C is enabled:

    ls /dev/i2c*
    # Should show /dev/i2c-1

Verify SPI is enabled:

    ls /dev/spidev*
    # Should show /dev/spidev0.0 and /dev/spidev0.1


Step 2: Wiring
--------------

### TCA9548A I2C Multiplexer

    Pi GPIO          TCA9548A
    ---------        --------
    Pin 1  (3.3V) -> VIN
    Pin 3  (SDA)  -> SDA
    Pin 5  (SCL)  -> SCL
    Pin 9  (GND)  -> GND

The TCA9548A default address is 0x70. If you need a different address,
solder the A0/A1/A2 pads and update MUX_ADDRESS in config.py.

### APDS-9960 Sensors (x6)

Connect each sensor to one channel on the TCA9548A:

    TCA9548A Channel    APDS-9960 Sensor
    ----------------    ----------------
    SD0/SC0 (ch 0)   -> Sensor 0 (ligand slot 0)
    SD1/SC1 (ch 1)   -> Sensor 1 (ligand slot 1)
    SD2/SC2 (ch 2)   -> Sensor 2 (ligand slot 2)
    SD3/SC3 (ch 3)   -> Sensor 3 (ligand slot 3)
    SD4/SC4 (ch 4)   -> Sensor 4 (ligand slot 4)
    SD5/SC5 (ch 5)   -> Sensor 5 (ligand slot 5)

Each APDS-9960 also needs:
- VIN -> 3.3V (from TCA9548A or Pi)
- GND -> GND

All 6 sensors share the same I2C address (0x39), which is why the
multiplexer is required.

### MFRC522 RFID Reader

    Pi GPIO              MFRC522
    ---------            -------
    Pin 24 (SPI CE0)  -> SDA (SS)
    Pin 23 (SPI SCLK) -> SCK
    Pin 19 (SPI MOSI) -> MOSI
    Pin 21 (SPI MISO) -> MISO
    Pin 22 (GPIO 25)  -> RST
    Pin 1  (3.3V)     -> 3.3V
    Pin 6  (GND)      -> GND

    IMPORTANT: The MFRC522 runs at 3.3V. Do NOT connect to 5V.

### Buttons

Wire each button between the GPIO pin and GND. The software enables
internal pull-up resistors, so no external resistors are needed.

    Pi GPIO              Button
    ---------            ------
    Pin 11 (GPIO 17)  -> Scan Nanoparticle button -> GND
    Pin 13 (GPIO 27)  -> Start Test button        -> GND
    Pin 15 (GPIO 22)  -> Reset button             -> GND

To use different GPIO pins, update the values in config.py:

    GPIO_BUTTON_SCAN = 17
    GPIO_BUTTON_TEST = 27
    GPIO_BUTTON_RESET = 22


Step 3: Install Python Dependencies
------------------------------------

    cd pi/
    pip install -r requirements.txt

If you encounter permission errors, use:

    pip install --user -r requirements.txt

Or create a virtual environment:

    python -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt


Step 4: Verify Sensor Wiring
-----------------------------

Run the I2C detection tool to verify the multiplexer is visible:

    sudo i2cdetect -y 1
    # Should show device at address 0x70

Run the sensor test script:

    python test_sensors.py

This will continuously print the detected color from each sensor channel.
Use --raw to see the raw RGBC values:

    python test_sensors.py --raw

Test a single channel:

    python test_sensors.py --single 0


Step 5: Calibrate Color Sensors
-------------------------------

The sensors need to be calibrated for your specific ligand pieces and
lighting conditions. Run the calibration utility:

    python color_calibration.py

The utility will prompt you to place each colored ligand (Red, Blue, Green,
Purple, Orange, Yellow) under sensor 0, then take 10 readings and average
them. It also calibrates the "empty slot" threshold.

Results are saved to color_map.json. Re-run calibration if you change:
- The physical ligand pieces (different material or paint)
- The sensor mounting distance
- The ambient lighting conditions


Step 6: Program RFID Tags
--------------------------

Each RFID tag stores a puzzle ID string that maps to a JSON puzzle file.

1. Create puzzle JSON files in the puzzles/ directory. Use
   puzzles/puzzle-example-01.json as a template.

2. Add entries to puzzles/index.json mapping tag text to filenames:

    {
      "puzzle-example-01": "puzzle-example-01.json",
      "puzzle-hard-02": "puzzle-hard-02.json"
    }

3. Write the puzzle ID string to each RFID tag. You can use any RFID
   writing tool, or create a simple Python script:

    from mfrc522 import SimpleMFRC522
    reader = SimpleMFRC522()
    reader.write("puzzle-example-01")


Step 7: Network Setup
----------------------

For a self-contained exhibit network (no internet required):

### Option A: Static IP (simplest)

Edit /etc/dhcpcd.conf on the Pi:

    interface eth0
    static ip_address=192.168.1.1/24
    nogateway

Set each client computer to a static IP in the same subnet:
- Client 1: 192.168.1.10
- Client 2: 192.168.1.11
- etc.

Connect all devices to an unmanaged Ethernet switch.

### Option B: Pi as DHCP server (automatic)

Install dnsmasq:

    sudo apt install dnsmasq

Edit /etc/dnsmasq.conf:

    interface=eth0
    dhcp-range=192.168.1.10,192.168.1.50,255.255.255.0,24h

Edit /etc/dhcpcd.conf:

    interface eth0
    static ip_address=192.168.1.1/24
    nogateway

Restart services:

    sudo systemctl restart dhcpcd
    sudo systemctl enable dnsmasq
    sudo systemctl start dnsmasq

Client computers will automatically receive IP addresses when connected
to the switch.


Step 8: Start the Master Server
--------------------------------

    cd pi/
    python master_server.py

The server starts on port 5000. You should see:

    INFO: Sensor service ready
    INFO: RFID service ready
    INFO: GPIO input ready
    INFO: Starting master server on 0.0.0.0:5000

To skip hardware that isn't connected (for testing):

    python master_server.py --no-gpio --no-sensors --no-rfid


Step 9: Connect Client Computers
----------------------------------

On each client computer, open the simulation in a web browser:

    http://192.168.1.1:5000/../concept_development/simulation_prototype/index.html?server=192.168.1.1:5000

Or serve the simulation files from the Pi by copying them to the static
directory, then load:

    http://192.168.1.1:5000/static/index.html?server=192.168.1.1:5000

The client will connect via Socket.IO and register with the master.
Tissues are assigned automatically based on the number of clients:
- 1 client: runs all 4 tissues
- 2 clients: 2 tissues each
- 4 clients: 1 tissue each


Step 10: Open the Results Display
-----------------------------------

On the Pi itself, open Chromium to the display page:

    chromium-browser --kiosk http://localhost:5000/

The --kiosk flag makes it full-screen with no browser UI (press Alt+F4
to exit). The display shows:
- Nanoparticle preview (scanned ligand colors)
- Puzzle info (tissue names and receptor profiles)
- Results bar charts (binding affinity + cell kill rate per tissue)
- Test progress and status


Step 11: Auto-Start on Boot (Optional)
----------------------------------------

Create a systemd service to start the master server automatically:

    sudo nano /etc/systemd/system/tdd-exhibit.service

Contents:

    [Unit]
    Description=Targeted Drug Delivery Exhibit
    After=network.target

    [Service]
    Type=simple
    User=pi
    WorkingDirectory=/home/pi/Targeted-Drug-Delivery/pi
    ExecStart=/usr/bin/python master_server.py
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target

Enable and start:

    sudo systemctl enable tdd-exhibit
    sudo systemctl start tdd-exhibit

To also auto-start the display in Chromium, add to
/etc/xdg/autostart/tdd-display.desktop:

    [Desktop Entry]
    Type=Application
    Name=TDD Display
    Exec=chromium-browser --kiosk http://localhost:5000/
    X-GNOME-Autostart-enabled=true


Troubleshooting
---------------

"No sensors detected"
- Check I2C is enabled: sudo raspi-config -> Interface Options -> I2C
- Check wiring: sudo i2cdetect -y 1 should show 0x70
- Check power: TCA9548A and sensors need 3.3V

"RFID read error"
- Check SPI is enabled: ls /dev/spidev*
- Check wiring: SDA goes to CE0 (pin 24), not a random GPIO
- Make sure tag is close to the reader antenna (within 2-3 cm)

"No simulation clients connected"
- Check network: ping the Pi from the client computer
- Check the browser console for Socket.IO connection errors
- Verify the ?server= URL parameter matches the Pi's IP and port

Sensors read wrong colors
- Re-run color_calibration.py
- Check ambient lighting (consistent lighting is important)
- Ensure sensors are at a consistent distance from the ligand pieces

Display not updating
- Check browser console for WebSocket errors
- Verify the display page joined the "display" room (check server logs)
- Try refreshing the page
