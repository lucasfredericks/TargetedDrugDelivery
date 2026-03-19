Raspberry Pi + Arduino Setup Instructions
==========================================

This guide covers setting up the Targeted Drug Delivery exhibit hardware.
The system uses two controllers:
- **Raspberry Pi**: Reads color sensors (I2C), runs the master server,
  and drives the results display
- **Arduino Uno**: Reads RFID tags (PN532 shield) and a start button,
  communicating with the Pi over USB serial


Prerequisites
-------------

Hardware:
- Raspberry Pi 5 with Raspberry Pi OS (Bookworm or later)
- MicroSD card (16 GB minimum)
- Power supply (USB-C, 5V 3A)
- HDMI cable + monitor (for results display)
- Ethernet cable + unmanaged switch (for client network)
- TCA9548A I2C multiplexer breakout
- 6x Adafruit APDS-9960 color/proximity sensor breakouts
- Arduino Uno
- Adafruit PN532 NFC/RFID Shield (product #789) + NFC tags
- 1x momentary push button (normally open) — start button
- Jumper wires, breadboard or perfboard

Software:
- Python 3.9 or later (pre-installed on Raspberry Pi OS)
- Arduino IDE (for uploading firmware to the Uno)


Step 1: Enable I2C on the Pi
-----------------------------

Open the Raspberry Pi configuration tool:

    sudo raspi-config

Navigate to Interface Options and enable:
- I2C (for color sensors via TCA9548A)

Note: SPI is NOT needed — RFID is handled by the Arduino.

Reboot after enabling:

    sudo reboot

Verify I2C is enabled:

    ls /dev/i2c*
    # Should show /dev/i2c-1


Step 2: Pi Wiring (Color Sensors)
----------------------------------

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


Step 3: Arduino Setup (RFID + Button)
--------------------------------------

### PN532 Shield Configuration

The Adafruit PN532 shield uses SPI mode. Check the silkscreen on your
specific board revision for the correct jumper settings:

    SEL0: closed
    SEL1: closed

Note: Jumper settings vary between board revisions — always check the
silkscreen printed on YOUR board rather than relying on online docs.

### PN532 Shield Solder Bridges

Bridge these pads on the shield (solder a blob across each pair):

    Shield Pad    Arduino Pin
    ----------    -----------
    IRQ        -> D2
    RST        -> D3
    SCK        -> D4
    MISO       -> D5
    SS         -> D6
    MOSI       -> D7

### Start Button

Wire a momentary push button between D8 and GND on the Arduino.
The firmware enables the internal pull-up resistor, so no external
resistor is needed.

    Arduino Pin 8 -> Button -> GND

### Upload Firmware

1. Open arduino/tdd_rfid/tdd_rfid.ino in the Arduino IDE
2. Install these libraries via Library Manager (Sketch -> Include Library):
   - Adafruit PN532
   - Adafruit BusIO (installed automatically as dependency)
3. Select Board: Arduino Uno, and the correct serial port
4. Upload

Verify in Serial Monitor (115200 baud):

    {"type":"ready","ic":"PN532","fw":"1.6"}

Place an NFC tag on the reader to confirm:

    {"type":"tag","uid":"AA:BB:CC:DD"}

### Connect to Pi

Connect the Arduino to the Pi via USB cable. It will appear as
/dev/ttyACM0 (auto-detected by the master server).


Step 4: Install Python Dependencies
------------------------------------

First, install system-level dependencies that require C compilation:

    sudo apt install swig python3-lgpio liblgpio-dev

Raspberry Pi OS Bookworm and later require a virtual environment for pip
installs. Use --system-site-packages so the venv can access system-installed
hardware libraries (lgpio, RPi.GPIO) that have C dependencies:

    cd pi/
    python -m venv --system-site-packages venv
    source venv/bin/activate
    pip install -r requirements.txt

You must activate the venv before running any Pi scripts:

    source venv/bin/activate

Tip: Add it to your .bashrc so it activates on login:

    echo 'source ~/TargetedDrugDelivery/pi/venv/bin/activate' >> ~/.bashrc


Step 5: Verify Sensor Wiring
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


Step 6: Calibrate Color Sensors
-------------------------------

The sensors need to be calibrated for your specific ligand pieces and
lighting conditions. Run the calibration utility:

    python color_calibration.py

The utility will prompt you to place each colored ligand (Red, Blue, Green,
Purple, Orange, Yellow) under each sensor, then take 10 readings and average
them. Calibration is per-sensor to account for LED brightness and mounting
differences. It also calibrates the "empty slot" reading.

Results are saved to color_map.json. Re-run calibration if you change:
- The physical ligand pieces (different material or paint)
- The sensor mounting distance or angle
- The lighting conditions (LEDs, shrouds, ambient light)


Step 7: Register RFID Tags
---------------------------

Each RFID tag is identified by its factory UID (no data needs to be written
to the tag). Use the admin dashboard to associate tags with puzzle files.

### Create Puzzle Files

Add puzzle JSON files to the puzzles/ directory. Use
puzzles/puzzle-example-01.json as a template.

### Associate Tags Using the Admin Dashboard

1. Start the master server (see Step 9) and open the admin dashboard in a
   browser:

       http://<pi-ip>:5000/admin

2. Place an RFID tag on the PN532 shield. The tag's UID will appear live in
   the "Live Tag Scanner" panel.

3. Click a puzzle file name in the "Puzzle Files" panel to select it.

4. Click "Associate Tag → Puzzle". The mapping is saved immediately to
   puzzles/index.json and takes effect without restarting the server.

5. Repeat for each tag. All current mappings are shown in the table at the
   bottom of the page. Use the "Remove" button to delete a mapping.

### Manual Editing (Alternative)

You can also edit puzzles/index.json directly:

    {
      "AA:BB:CC:DD": "puzzle-example-01.json",
      "11:22:33:44": "puzzle-hard-02.json"
    }

Restart the master server after manual edits for changes to take effect.


Step 8: Network Setup
----------------------

For a self-contained exhibit network (no internet required):

Note: Raspberry Pi OS Bookworm uses NetworkManager (nmcli), not dhcpcd.
The dhcpcd.conf file may exist but has no effect.

### Option A: Static IP (simplest)

Set a static IP on the Pi's Ethernet interface using nmcli:

    # Find the connection name (typically "Wired connection 1")
    nmcli connection show

    sudo nmcli connection modify "Wired connection 1" \
      ipv4.method manual \
      ipv4.addresses 192.168.1.1/24 \
      ipv4.gateway "" \
      ipv4.never-default yes

    sudo nmcli connection up "Wired connection 1"

Verify with:

    ip addr show eth0
    # Should show: inet 192.168.1.1/24

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

Set the Pi's static IP using nmcli (same as Option A above), then
restart services:

    sudo systemctl enable dnsmasq
    sudo systemctl start dnsmasq

Client computers will automatically receive IP addresses when connected
to the switch.


Step 9: Start the Master Server
--------------------------------

    cd pi/
    python master_server.py

The server starts on port 5000. You should see:

    INFO: Color sensor service ready
    INFO: Arduino RFID/button ready
    INFO: Starting master server on 0.0.0.0:5000

To skip hardware that isn't connected (for testing):

    python master_server.py --no-sensors      # Skip color sensors
    python master_server.py --no-rfid         # Skip Arduino RFID
    python master_server.py --no-hardware     # Skip all hardware

To specify the Arduino serial port manually:

    python master_server.py --serial /dev/ttyACM0


Step 10: Connect Client Computers
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


Step 11: Open the Results Display
-----------------------------------

On the Pi itself, open Chromium to the display page:

    chromium-browser --kiosk http://localhost:5000/

The --kiosk flag makes it full-screen with no browser UI (press Alt+F4
to exit). The display shows:
- Nanoparticle preview (scanned ligand colors)
- Puzzle info (tissue names and receptor profiles)
- Results bar charts (binding affinity + cell kill rate per tissue)
- Test progress and status


Step 12: Auto-Start on Boot (Optional)
----------------------------------------

Create a systemd service to start the master server automatically:

    sudo nano /etc/systemd/system/tdd-exhibit.service

Contents:

    [Unit]
    Description=Targeted Drug Delivery Exhibit
    After=network.target

    [Service]
    Type=simple
    User=tdd
    WorkingDirectory=/home/tdd/TargetedDrugDelivery/pi
    ExecStart=/home/tdd/TargetedDrugDelivery/pi/venv/bin/python master_server.py
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
    Version=1.0
    Type=Application
    Name=TDD Display
    Exec=chromium --kiosk http://localhost:5000/
    X-GNOME-Autostart-enabled=true


Troubleshooting
---------------

"No sensors detected"
- Check I2C is enabled: sudo raspi-config -> Interface Options -> I2C
- Check wiring: sudo i2cdetect -y 1 should show 0x70
- Check power: TCA9548A and sensors need 3.3V

"PN532 not found" (Arduino serial monitor)
- Check shield SEL jumpers match the silkscreen for SPI mode
- Verify solder bridges: IRQ->D2, RST->D3, SCK->D4, MISO->D5, SS->D6, MOSI->D7
- Try power cycling the Arduino (unplug USB and replug)
- Run the Adafruit readMifare example sketch to test independently

"Arduino not connected" (Pi master server)
- Check USB cable between Arduino and Pi
- Verify the Arduino appears: ls /dev/ttyACM*
- Try specifying the port: python master_server.py --serial /dev/ttyACM0

"No simulation clients connected"
- Check network: ping the Pi from the client computer
- Check the browser console for Socket.IO connection errors
- Verify the ?server= URL parameter matches the Pi's IP and port

Sensors read wrong colors
- Re-run color_calibration.py
- Calibration is per-sensor — make sure each sensor is calibrated individually
- Check ambient lighting (consistent lighting is important)
- Ensure sensors are at a consistent distance from the ligand pieces
- Use test_sensors.py --raw to inspect RGBC values

Display not updating
- Check browser console for WebSocket errors
- Verify the display page joined the "display" room (check server logs)
- Try refreshing the page
