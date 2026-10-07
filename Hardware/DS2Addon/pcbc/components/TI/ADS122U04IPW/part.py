from pcbc import Component

# Analog To Digital Converters (ADCs). Fetched from LCSC C1543140 by pcbc fetch; library quality usable (85/100).
# Pins: GPIO1(1) GPIO0(2) ~{RESET}(3) DGND(4) AVSS(5) AIN3(6) AIN2(7) REFN(8) REFP(9) AIN1(10)
#       AIN0(11) AVDD(12) DVDD(13) GPIO2/~{DRDY}(14) TX(15) RX(16)
part = Component(
    name="ADS122U04IPW",
    prefix="U",
    mpn="ADS122U04IPW",
    manufacturer="TI",
    lcsc="C1543140",
    footprint="TSSOP-16_L5.0-W4.4-P0.65-LS6.4-BL.kicad_mod",
    symbol="ADS122U04IPW.kicad_sym",
    body_mm=(5.00, 4.40),
)
