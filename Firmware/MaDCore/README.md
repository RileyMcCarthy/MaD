# First-time Setup

## Platform.io

Platform.io must be installed inside Visual Studio Code to build firmware: https://docs.platformio.org/en/latest/integration/ide/vscode.html#installation

Make sure to remove previous Platform Propeller installations under Platform.io-> Home -> Platforms

Install the Propeller Platform.io platform using the instructions at the link below
https://github.com/RileyMcCarthy/platform-propeller

Once the custom Platform.io platform is installed clone this repository

`https://github.com/RileyMcCarthy/MaD-Firmware.git`

To build the firmware open the MaD-Firmware folder to compile and upload!

# Firmware setup

## Abstraction Layers

### HW
The hardware layer defines PCBA layout, micrcontroller specific tools and functions.
1. Most hardware specific code for this project is included in propeller2.h.

### HAL
The hardware abstraction layer is used to generalize the software from the hardware. Only this layer is alowed to call HW functions inside propeller2.h and write to registers.
1. GPIO
2. hardware serial
3. hardware encoder
4. I2C

### IO
The input/output layer is used to define tools used to interact with HAL, define protocols of communcation, and drivers. 
1. ADS122U04
2. Serial Protocol
3. JSON? -> this should be library

### DEV
The device layer can combine the HAL + IO layer to develop drivers for devices.
1. Stepper motor
2. COG Manager (should be replaced by RTOS eventually)
3. Logging
4. NVRAM (only implements SD card nvram)
5. Navkey (need to update driver to be more stable)
6. Watchdog (is this dev?)

### Library
Librarys should be completely seperate from any project dependencies
1. Static Queue
2. Timers
3. Utility