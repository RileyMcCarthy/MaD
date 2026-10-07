"""DS2 Addon rev 2: the DS2 force gauge's strain bridge into an ADS122U04, for the EdgeBoard.

Rev 1's netlist (exported from ../KICAD/DS2_Addon.kicad_sch with kicad-cli) is kept net for net.
What rev 2 changes is what the bring-up taught (../readme.md):

- the ~RESET pull-up R10 is on the board (pre-R10 boards floated the pin and the ADC ignored UART);
- the input and reference RC filters are populated (rev 1 left them DNP behind solder jumpers
  JP1..JP4, so the analog inputs were open by default); the jumpers are gone;
- every part carries an LCSC id, so the JLC package comes out of `pcbc build`.

Assumed values, to be checked against the DS2 gauge's bridge: 1 kΩ series with 100 nF to VSS on
each input and reference (1.6 kHz), 1 µF across each pair (TI's 10:1 differential-to-common).
"""

from pcbc import Board, Capacitor, Chain, Ground, Net, NetReq, Place, Power, Resistor, SchPlace, SchRegion, load

# Digital domain: from the EdgeBoard through J1.
V33 = Power("3V3")
GND = Ground("GND")
# Analog domain: from the DS2 gauge through J2; isolated from the digital rails.
VDDA = Power("VDDA")
VSS = Ground("VSS")

A0, A1, A2, A3 = Net("A0"), Net("A1"), Net("A2"), Net("A3")  # the gauge's four wires
AIN0, AIN1, AIN2, AIN3 = Net("AIN0"), Net("AIN1"), Net("AIN2"), Net("AIN3")  # filtered, at the ADC
REFP, REFN = Net("REFP"), Net("REFN")  # the reference header
REFP_F, REFN_F = Net("REFP_F"), Net("REFN_F")  # filtered, at the ADC
UART_RX, UART_TX, DRDY = Net("UART_RX"), Net("UART_TX"), Net("DRDY")  # the EdgeBoard's lines
ADC_RX, ADC_TX, ADC_DRDY = Net("ADC_RX"), Net("ADC_TX"), Net("ADC_DRDY")  # after 47 Ω
GPIO0, GPIO1 = Net("GPIO0"), Net("GPIO1")
nRESET = Net("nRESET")

ADC = load("components/TI/ADS122U04IPW")
H5 = load("components/XFCN/PZ254V-11-05P")
H4 = load("components/XFCN/PZ254V-11-04P")
H3 = load("components/XFCN/PZ254V-11-03P")
H2 = load("components/XFCN/PZ254V-11-02P")

ADC(
    "U1",
    GPIO1=GPIO1,
    GPIO0=GPIO0,
    DGND=GND,
    AVSS=VSS,
    AIN3=AIN3,
    AIN2=AIN2,
    REFN=REFN_F,
    REFP=REFP_F,
    AIN1=AIN1,
    AIN0=AIN0,
    AVDD=VDDA,
    DVDD=V33,
    TX=ADC_TX,
    RX=ADC_RX,
    **{"~{RESET}": nRESET, "GPIO2/~{DRDY}": ADC_DRDY},
)
H5("J1", **{"1": V33, "2": GND, "3": UART_RX, "4": UART_TX, "5": DRDY})  # MCU
H4("J2", **{"1": VDDA, "2": VSS, "3": A0, "4": A1})  # Analog1: the gauge's supply and bridge
H2("J5", **{"1": A2, "2": A3})  # Analog2
H2("J4", **{"1": REFN, "2": REFP})  # Reference
H3("J3", **{"1": GPIO0, "2": GPIO1, "3": GND})

r = dict(package="0805", manufacturer="UniOhm")
c = dict(package="0805", manufacturer="Yageo")
# Decoupling: one per supply pin, plus the digital rail's bulk. 0603, so two of them fit on the
# ADC's adjacent 0.65 mm supply pins (AVDD next to DVDD) within a millimetre or two.
Capacitor("C4", "100nF", package="0603", mpn="CL10B104KB8NNNC", lcsc="C1591", manufacturer="Samsung", p1=VDDA, p2=VSS)
Capacitor("C5", "100nF", package="0603", mpn="CL10B104KB8NNNC", lcsc="C1591", manufacturer="Samsung", p1=V33, p2=GND)
Capacitor("C6", "1uF", package="0603", mpn="CL10A105KB8NNNC", lcsc="C15849", manufacturer="Samsung", p1=V33, p2=GND)
Resistor("R10", "10k", mpn="0805W8F1002T5E", lcsc="C17414", p1=V33, p2=nRESET, **r)
# 47 Ω in series with the UART lines and DRDY, as rev 1.
Resistor("R3", "47R", mpn="FRC0805F47R0TS", lcsc="C2907268", p1=UART_RX, p2=ADC_RX, **r)
Resistor("R4", "47R", mpn="FRC0805F47R0TS", lcsc="C2907268", p1=UART_TX, p2=ADC_TX, **r)
Resistor("R5", "47R", mpn="FRC0805F47R0TS", lcsc="C2907268", p1=DRDY, p2=ADC_DRDY, **r)
# Input filters: series R, common-mode C to VSS, differential C across the pair.
Resistor("R6", "1k", mpn="0805W8F1001T5E", lcsc="C17513", p1=A0, p2=AIN0, **r)
Resistor("R7", "1k", mpn="0805W8F1001T5E", lcsc="C17513", p1=A1, p2=AIN1, **r)
Resistor("R8", "1k", mpn="0805W8F1001T5E", lcsc="C17513", p1=A2, p2=AIN2, **r)
Resistor("R9", "1k", mpn="0805W8F1001T5E", lcsc="C17513", p1=A3, p2=AIN3, **r)
Capacitor("C7", "100nF", mpn="CC0805KRX7R9BB104", lcsc="C49678", p1=AIN0, p2=VSS, **c)
Capacitor("C9", "100nF", mpn="CC0805KRX7R9BB104", lcsc="C49678", p1=AIN1, p2=VSS, **c)
Capacitor("C8", "1uF", mpn="CGA0805X7R105K250KT", lcsc="C45359957", manufacturer="TDK", package="0805", p1=AIN0, p2=AIN1)
Capacitor("C10", "100nF", mpn="CC0805KRX7R9BB104", lcsc="C49678", p1=AIN2, p2=VSS, **c)
Capacitor("C12", "100nF", mpn="CC0805KRX7R9BB104", lcsc="C49678", p1=AIN3, p2=VSS, **c)
Capacitor("C11", "1uF", mpn="CGA0805X7R105K250KT", lcsc="C45359957", manufacturer="TDK", package="0805", p1=AIN2, p2=AIN3)
# Reference filter, the same shape.
Resistor("R1", "1k", mpn="0805W8F1001T5E", lcsc="C17513", p1=REFN, p2=REFN_F, **r)
Resistor("R2", "1k", mpn="0805W8F1001T5E", lcsc="C17513", p1=REFP, p2=REFP_F, **r)
Capacitor("C1", "100nF", mpn="CC0805KRX7R9BB104", lcsc="C49678", p1=REFN_F, p2=VSS, **c)
Capacitor("C3", "100nF", mpn="CC0805KRX7R9BB104", lcsc="C49678", p1=REFP_F, p2=VSS, **c)
Capacitor("C2", "1uF", mpn="CGA0805X7R105K250KT", lcsc="C45359957", manufacturer="TDK", package="0805", p1=REFN_F, p2=REFP_F)

# Rev 1's outline: 47 x 25.4 mm, two layers, the headers on the edges they were on.
Board(width=47, height=25.4, layers=2, stackup="jlcpcb_2l_1oz")
NetReq("3V3", "GND", "VDDA", "VSS", kind="power", volts=3.3, amps=0.1)
NetReq("AIN0", "AIN1", "AIN2", "AIN3", "REFP_F", "REFN_F", kind="analog", max_mm=30)  # filters at the connectors, ADC in the middle of 47 mm
Chain("VDDA", "J2.1", "C4.1", "U1.12")  # the analog rail feeds through its cap before the pin

# Schematic: groups in order, parts hung off pins. The tool stacks the
# headers, picks a free side, and fits each box.
SchRegion("inputs", title="Inputs")
SchPlace("J2", mirror="y")
SchPlace("J5", below="J2", mirror="y")
SchPlace("J4", below="J5", mirror="y")
SchPlace("R6", to="J2.3")
SchPlace("R7", to="J2.4")
SchPlace("C7", to="R6.2")
SchPlace("C8", to="R6.2")
SchPlace("C9", to="R7.2")
SchPlace("R8", to="J5.1")
SchPlace("R9", to="J5.2")
SchPlace("C10", to="R8.2")
SchPlace("C11", to="R8.2")
SchPlace("C12", to="R9.2")
SchPlace("R1", to="J4.1")
SchPlace("R2", to="J4.2")
SchPlace("C1", to="R1.2")
SchPlace("C2", to="R1.2")
SchPlace("C3", to="R2.2")

SchRegion("adc", title="ADC")
SchPlace("U1")
SchPlace("C5", to="U1.DVDD")
SchPlace("C6", along="C5.1", side="bottom")
SchPlace("C4", to="U1.AVDD")
SchPlace("R10", to="U1.~{RESET}")
SchPlace("R3", to="U1.RX")
SchPlace("R4", to="U1.TX")
SchPlace("R5", to="U1.GPIO2/~{DRDY}")

SchRegion("edge", title="EdgeBoard")
SchPlace("J1", mirror="y")
SchPlace("J3", below="J1", mirror="y")

# Copper: headers on their rev 1 edges; the ADC between the gauge side and the EdgeBoard side.
Place("J2", edge="left", reason="gauge supply and bridge")
Place("J5", edge="right", reason="bridge, second pair")
Place("J4", edge="top", right=8, reason="reference, off to the side so the ADC's top pin row has room")
Place("J1", edge="bottom", left=12, reason="EdgeBoard")
Place("J3", edge="bottom", right=8, reason="GPIO")
Place("U1", position="absolute", left=20, top=10, reason="ADC in the middle")
# Only the decoupling and the pull-up crowd the ADC: a TSSOP's 0.65 mm pad rows need their
# escapes. The series resistors go at the MCU header, each filter at the connector it serves.
Place("C5", to="U1.DVDD")
Place("C4", to="U1.AVDD")
Place("C6", to="U1.DVDD")
Place("R10", to="U1.~{RESET}")
Place("R3", to="J1.3")
Place("R4", to="J1.4")
Place("R5", to="J1.5")
Place("R6", to="J2.3")
Place("R7", to="J2.4")
Place("C7", to="R6.2")
Place("C8", to="R6.2")
Place("C9", to="R7.2")
Place("R8", to="J5.1")
Place("R9", to="J5.2")
Place("C10", to="R8.2")
Place("C11", to="R8.2")
Place("C12", to="R9.2")
Place("R1", to="J4.1")
Place("R2", to="J4.2")
Place("C1", to="R1.2")
Place("C2", to="R1.2")
Place("C3", to="R2.2")
