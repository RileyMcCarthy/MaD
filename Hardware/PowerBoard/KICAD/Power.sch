EESchema Schematic File Version 4
EELAYER 30 0
EELAYER END
$Descr A4 11693 8268
encoding utf-8
Sheet 1 1
Title "MaD Power Management"
Date "2021-03-24"
Rev "1"
Comp ""
Comment1 "Place 4 x 3 mm Holes to Mount Guard Over AC Terminals and Fuses"
Comment2 "Jumpers Must be Ganged - Horizontal Spacing 0.254 mm"
Comment3 ""
Comment4 ""
$EndDescr
$Comp
L Switch:SW_Push_Open SW4
U 1 1 605C48EE
P 3000 850
F 0 "SW4" H 3000 1065 50  0000 C CNN
F 1 "Off" H 3000 974 50  0000 C CNN
F 2 "" H 3000 1050 50  0001 C CNN
F 3 "~" H 3000 1050 50  0001 C CNN
	1    3000 850 
	1    0    0    -1  
$EndComp
$Comp
L Switch:SW_Push SW9
U 1 1 605C5ADA
P 3600 850
F 0 "SW9" H 3600 1135 50  0000 C CNN
F 1 "On" H 3600 1044 50  0000 C CNN
F 2 "" H 3600 1050 50  0001 C CNN
F 3 "~" H 3600 1050 50  0001 C CNN
	1    3600 850 
	1    0    0    -1  
$EndComp
$Comp
L Switch:SW_SPDT SW3
U 1 1 605C6FEB
P 950 950
F 0 "SW3" H 950 1235 50  0000 C CNN
F 1 "SW_SPDT" H 950 1144 50  0000 C CNN
F 2 "" H 950 950 50  0001 C CNN
F 3 "~" H 950 950 50  0001 C CNN
	1    950  950 
	1    0    0    -1  
$EndComp
$Comp
L Switch:SW_SPDT SW8
U 1 1 605C772F
P 3300 2900
F 0 "SW8" H 3300 3185 50  0000 C CNN
F 1 "Lower_Over_Travel" V 3300 3094 50  0000 C CNN
F 2 "" H 3300 2900 50  0001 C CNN
F 3 "~" H 3300 2900 50  0001 C CNN
	1    3300 2900
	0    1    1    0   
$EndComp
$Comp
L Switch:SW_SPDT SW1
U 1 1 605C7D09
P 900 1500
F 0 "SW1" H 900 1785 50  0000 C CNN
F 1 "SW_SPDT" H 900 1694 50  0000 C CNN
F 2 "" H 900 1500 50  0001 C CNN
F 3 "~" H 900 1500 50  0001 C CNN
	1    900  1500
	1    0    0    -1  
$EndComp
$Comp
L Switch:SW_SPDT SW2
U 1 1 605C80F3
P 900 2000
F 0 "SW2" H 900 2285 50  0000 C CNN
F 1 "SW_SPDT" H 900 2194 50  0000 C CNN
F 2 "" H 900 2000 50  0001 C CNN
F 3 "~" H 900 2000 50  0001 C CNN
	1    900  2000
	1    0    0    -1  
$EndComp
$Comp
L Switch:SW_SPDT SW7
U 1 1 605C84DC
P 3300 2350
F 0 "SW7" H 3300 2635 50  0000 C CNN
F 1 "Upper_Over_Travel" V 3300 2544 50  0000 C CNN
F 2 "" H 3300 2350 50  0001 C CNN
F 3 "~" H 3300 2350 50  0001 C CNN
	1    3300 2350
	0    1    1    0   
$EndComp
$Comp
L Power-rescue:NUD3124LT1G-Driver_Relay_bbg U1
U 1 1 605EDAFD
P 2450 4250
F 0 "U1" H 2700 4875 50  0000 C CNN
F 1 "NUD3124LT1G" H 2700 4784 50  0000 C CNN
F 2 "" H 2700 4825 50  0001 C CNN
F 3 "" H 2700 4825 50  0001 C CNN
	1    2450 4250
	1    0    0    -1  
$EndComp
Wire Wire Line
	3400 2550 3400 2700
Wire Wire Line
	3400 2700 3300 2700
Text GLabel 3400 3250 3    50   BiDi ~ 0
GPO_1+_Dry
$Comp
L Switch:SW_Push SW5
U 1 1 60601BCD
P 3100 1850
F 0 "SW5" V 3054 1998 50  0000 R CNN
F 1 "NO" V 3145 1998 50  0000 R CNN
F 2 "" H 3100 2050 50  0001 C CNN
F 3 "~" H 3100 2050 50  0001 C CNN
	1    3100 1850
	0    1    1    0   
$EndComp
$Comp
L Switch:SW_Push_Open SW6
U 1 1 60601BC7
P 3300 1850
F 0 "SW6" H 3300 2065 50  0000 L CNN
F 1 "ESD" V 3300 1974 50  0000 L CNN
F 2 "" H 3300 2050 50  0001 C CNN
F 3 "~" H 3300 2050 50  0001 C CNN
	1    3300 1850
	0    1    -1   0   
$EndComp
Text GLabel 3300 1500 0    50   Input ~ 0
VIN_IO(12V)
Wire Wire Line
	3300 1500 3300 1650
Text Notes 4350 5100 3    50   ~ 0
Inlet\nEMI\nG  N  L
Text Notes 4400 3200 3    50   ~ 0
ESD\n- +
Text GLabel 2700 850  0    50   Input ~ 0
DC_Out_OnOff_+
$Comp
L Connector:Screw_Terminal_01x02 J8
U 1 1 6063B0FB
P 4450 3250
F 0 "J8" H 4368 3467 50  0000 C CNN
F 1 "2.54mmx1mm" H 4368 3376 50  0000 C CNN
F 2 "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MPT-0,5-2-2.54_1x02_P2.54mm_Horizontal" H 4450 3250 50  0001 C CNN
F 3 "~" H 4450 3250 50  0001 C CNN
	1    4450 3250
	-1   0    0    -1  
$EndComp
Text Notes 4400 2150 3    50   ~ 0
DC IN\n(12-26V)\n-  +
Text Notes 4300 900  0    50   ~ 0
DC OUT\nP1\n - +
Text Notes 4700 900  0    50   ~ 0
DC OUT\nT Main\n - +
Text Notes 5100 900  0    50   ~ 0
DC OUT\nOn/Off\n - +
Text Notes 6450 900  0    50   ~ 0
DC OUT\nT IO\n - +
$Comp
L Connector:Screw_Terminal_01x02 J5
U 1 1 60650705
P 4450 950
F 0 "J5" V 4414 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 4323 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 4450 950 50  0001 C CNN
F 3 "~" H 4450 950 50  0001 C CNN
	1    4450 950 
	0    1    -1   0   
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J9
U 1 1 60651FB2
P 4850 950
F 0 "J9" V 4814 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 4723 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 4850 950 50  0001 C CNN
F 3 "~" H 4850 950 50  0001 C CNN
	1    4850 950 
	0    1    -1   0   
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J12
U 1 1 606530A0
P 6600 950
F 0 "J12" V 6564 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 6473 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 6600 950 50  0001 C CNN
F 3 "~" H 6600 950 50  0001 C CNN
	1    6600 950 
	0    1    -1   0   
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J10
U 1 1 606528A6
P 5250 950
F 0 "J10" V 5214 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 5123 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 5250 950 50  0001 C CNN
F 3 "~" H 5250 950 50  0001 C CNN
	1    5250 950 
	0    1    -1   0   
$EndComp
Text Notes 7000 650  0    50   ~ 0
Switched
Text Notes 5500 900  0    50   ~ 0
DC OUT\nAux 1\n - +
$Comp
L Connector:Screw_Terminal_01x02 J11
U 1 1 60664AD7
P 5650 950
F 0 "J11" V 5614 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 5523 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 5650 950 50  0001 C CNN
F 3 "~" H 5650 950 50  0001 C CNN
	1    5650 950 
	0    1    -1   0   
$EndComp
Text Notes 6850 900  0    50   ~ 0
DC OUT\nAux 2\n - +
Text Notes 7250 900  0    50   ~ 0
DC OUT\nAux 3\n - +
Text Notes 7650 900  0    50   ~ 0
DC OUT\nAux 4\n - +
$Comp
L Connector:Screw_Terminal_01x02 J13
U 1 1 6066923C
P 7000 950
F 0 "J13" V 6964 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 6873 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 7000 950 50  0001 C CNN
F 3 "~" H 7000 950 50  0001 C CNN
	1    7000 950 
	0    1    -1   0   
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J14
U 1 1 6066B603
P 7400 950
F 0 "J14" V 7364 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 7273 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 7400 950 50  0001 C CNN
F 3 "~" H 7400 950 50  0001 C CNN
	1    7400 950 
	0    1    -1   0   
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J15
U 1 1 6066B609
P 7800 950
F 0 "J15" V 7764 1030 50  0000 L CNN
F 1 "3.5mmx0.7mm" V 7673 1030 50  0000 L CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 7800 950 50  0001 C CNN
F 3 "~" H 7800 950 50  0001 C CNN
	1    7800 950 
	0    1    -1   0   
$EndComp
Text GLabel 4650 3250 2    50   Input ~ 0
ESD_+
Text GLabel 4650 3350 2    50   Input ~ 0
ESD_-
$Comp
L power:GND #PWR0101
U 1 1 60685114
P 4350 1250
F 0 "#PWR0101" H 4350 1000 50  0001 C CNN
F 1 "GND" H 4355 1077 50  0000 C CNN
F 2 "" H 4350 1250 50  0001 C CNN
F 3 "" H 4350 1250 50  0001 C CNN
	1    4350 1250
	1    0    0    -1  
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J7
U 1 1 6068C134
P 4450 2850
F 0 "J7" H 4368 3067 50  0000 C CNN
F 1 "2.54mmx1mm" H 4368 2976 50  0000 C CNN
F 2 "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MPT-0,5-2-2.54_1x02_P2.54mm_Horizontal" H 4450 2850 50  0001 C CNN
F 3 "~" H 4450 2850 50  0001 C CNN
	1    4450 2850
	-1   0    0    -1  
$EndComp
Text GLabel 4650 2850 2    50   Input ~ 0
SW_ON
Text GLabel 4650 2950 2    50   Input ~ 0
SW_OFF
Text Notes 4250 3000 0    50   ~ 0
 On\n\nOff\n
Text GLabel 5800 1200 2    50   Input ~ 0
DC_IN_+
Wire Wire Line
	3300 2050 3300 2150
Text GLabel 3600 3100 2    50   Input ~ 0
ESD_+
Text GLabel 3600 3200 2    50   BiDi ~ 0
ESD_-
Wire Wire Line
	3400 3200 3600 3200
$Comp
L power:GND #PWR0102
U 1 1 606DE3A9
P 3400 4650
F 0 "#PWR0102" H 3400 4400 50  0001 C CNN
F 1 "GND" H 3405 4477 50  0000 C CNN
F 2 "" H 3400 4650 50  0001 C CNN
F 3 "" H 3400 4650 50  0001 C CNN
	1    3400 4650
	1    0    0    -1  
$EndComp
$Comp
L Connector:Screw_Terminal_01x03 J2
U 1 1 606EC977
P 4400 5250
F 0 "J2" H 4318 5567 50  0000 C CNN
F 1 "5.08mmx1mm" H 4318 5476 50  0000 C CNN
F 2 "TerminalBlock:TerminalBlock_bornier-3_P5.08mm" H 4400 5250 50  0001 C CNN
F 3 "~" H 4400 5250 50  0001 C CNN
	1    4400 5250
	-1   0    0    -1  
$EndComp
$Comp
L Connector:Screw_Terminal_01x03 J1
U 1 1 606F103E
P 4400 4550
F 0 "J1" H 4318 4867 50  0000 C CNN
F 1 "5.08mmx1mm" H 4318 4776 50  0000 C CNN
F 2 "TerminalBlock:TerminalBlock_bornier-3_P5.08mm" H 4400 4550 50  0001 C CNN
F 3 "~" H 4400 4550 50  0001 C CNN
	1    4400 4550
	-1   0    0    -1  
$EndComp
$Comp
L power:Earth_Protective #PWR0103
U 1 1 606F4D13
P 4600 4650
F 0 "#PWR0103" H 4850 4400 50  0001 C CNN
F 1 "Earth_Protective" H 5050 4500 50  0001 C CNN
F 2 "" H 4600 4550 50  0001 C CNN
F 3 "~" H 4600 4550 50  0001 C CNN
	1    4600 4650
	1    0    0    -1  
$EndComp
$Comp
L power:Earth_Protective #PWR0104
U 1 1 606F52CE
P 6900 4650
F 0 "#PWR0104" H 7150 4400 50  0001 C CNN
F 1 "Earth_Protective" H 7350 4500 50  0001 C CNN
F 2 "" H 6900 4550 50  0001 C CNN
F 3 "~" H 6900 4550 50  0001 C CNN
	1    6900 4650
	-1   0    0    -1  
$EndComp
$Comp
L power:Earth_Protective #PWR0105
U 1 1 606F5A95
P 4600 5350
F 0 "#PWR0105" H 4850 5100 50  0001 C CNN
F 1 "Earth_Protective" H 5050 5200 50  0001 C CNN
F 2 "" H 4600 5250 50  0001 C CNN
F 3 "~" H 4600 5250 50  0001 C CNN
	1    4600 5350
	1    0    0    -1  
$EndComp
Text GLabel 4600 5150 2    50   Input ~ 0
Line_IN
Text GLabel 4600 5250 2    50   Input ~ 0
Neut_IN
Text GLabel 6500 4450 2    50   Input ~ 0
Line_IN
Text GLabel 6500 4650 2    50   Input ~ 0
Neut_IN
$Comp
L Filter:FN406-1-02 FL1
U 1 1 605BC105
P 6200 4550
F 0 "FL1" H 6200 4875 50  0000 C CNN
F 1 "FN406-1-02" H 6200 4784 50  0000 C CNN
F 2 "Filter:Filter_Schaffner_FN406" H 6200 4550 50  0001 C CNN
F 3 "https://www.schaffner.com/products/download/product/datasheet/fn-406-ultra-compact-emc-filter/" H 6200 4550 50  0001 C CNN
	1    6200 4550
	-1   0    0    -1  
$EndComp
Wire Wire Line
	6500 4550 6900 4550
Text GLabel 4600 4450 2    50   Input ~ 0
Line_DC_PWR
Text GLabel 4600 4550 2    50   Input ~ 0
Neut_DC_PWR
Text Notes 4350 4400 3    50   ~ 0
DC PWR\nLine\nG  N  L
$Comp
L power:Earth_Protective #PWR0106
U 1 1 6075D6A6
P 5350 5350
F 0 "#PWR0106" H 5600 5100 50  0001 C CNN
F 1 "Earth_Protective" H 5800 5200 50  0001 C CNN
F 2 "" H 5350 5250 50  0001 C CNN
F 3 "~" H 5350 5250 50  0001 C CNN
	1    5350 5350
	1    0    0    -1  
$EndComp
Text GLabel 5900 5150 0    50   Input ~ 0
Line_Servo
Text GLabel 5900 5350 0    50   Input ~ 0
Neut_Servo
$Comp
L Filter:FN406-1-02 FL2
U 1 1 6075D6AF
P 6200 5250
F 0 "FL2" H 6200 5575 50  0000 C CNN
F 1 "FN406-1-02" H 6200 5484 50  0000 C CNN
F 2 "Filter:Filter_Schaffner_FN406" H 6200 5250 50  0001 C CNN
F 3 "https://www.schaffner.com/products/download/product/datasheet/fn-406-ultra-compact-emc-filter/" H 6200 5250 50  0001 C CNN
	1    6200 5250
	1    0    0    -1  
$EndComp
Text GLabel 6500 5150 2    50   Input ~ 0
LIne_Fuse
Text GLabel 6500 5350 2    50   Input ~ 0
Neut_Fuse
Wire Wire Line
	5900 5250 5350 5250
$Comp
L Connector:Screw_Terminal_01x02 J3
U 1 1 6079F678
P 4400 5850
F 0 "J3" H 4318 6067 50  0000 C CNN
F 1 "5mmx1mm" H 4318 5976 50  0000 C CNN
F 2 "TerminalBlock_RND:TerminalBlock_RND_205-00012_1x02_P5.00mm_Horizontal" H 4400 5850 50  0001 C CNN
F 3 "~" H 4400 5850 50  0001 C CNN
	1    4400 5850
	-1   0    0    -1  
$EndComp
Text GLabel 4600 5850 2    50   Input ~ 0
Line_Servo
Text GLabel 4600 5950 2    50   Input ~ 0
Neut_Servo
Text Notes 4400 5800 3    50   ~ 0
S  R\n\n
$Comp
L Power-rescue:3413_0328_22-dk_Fuses F2
U 1 1 60766B59
P 6250 5900
F 0 "F2" H 6250 6147 60  0000 C CNN
F 1 "Wurth 696106003002‎ (15mm x 1.5mm)" H 6250 6041 60  0000 C CNN
F 2 "MaD_Power_Board:732-11374-ND" H 6450 6100 60  0001 L CNN
F 3 "https://us.schurter.com/pdf/english/typ_UST_1206.pdf" H 6450 6200 60  0001 L CNN
F 4 "486-1686-1-ND" H 6450 6300 60  0001 L CNN "Digi-Key_PN"
F 5 "3413.0328.22" H 6450 6400 60  0001 L CNN "MPN"
F 6 "Circuit Protection" H 6450 6500 60  0001 L CNN "Category"
F 7 "Fuses" H 6450 6600 60  0001 L CNN "Family"
F 8 "https://us.schurter.com/pdf/english/typ_UST_1206.pdf" H 6450 6700 60  0001 L CNN "DK_Datasheet_Link"
F 9 "/product-detail/en/schurter-inc/3413.0328.22/486-1686-1-ND/2870095" H 6450 6800 60  0001 L CNN "DK_Detail_Page"
F 10 "FUSE BOARD MOUNT 10A 32VAC 63VDC" H 6450 6900 60  0001 L CNN "Description"
F 11 "Schurter Inc." H 6450 7000 60  0001 L CNN "Manufacturer"
F 12 "Active" H 6450 7100 60  0001 L CNN "Status"
	1    6250 5900
	1    0    0    -1  
$EndComp
$Comp
L Power-rescue:3413_0328_22-dk_Fuses F3
U 1 1 607BBA26
P 6250 6250
F 0 "F3" H 6250 6497 60  0000 C CNN
F 1 "Wurth 696106003002‎ (15mm x 1.5mm)" H 6250 6391 60  0000 C CNN
F 2 "MaD_Power_Board:732-11374-ND" H 6450 6450 60  0001 L CNN
F 3 "https://us.schurter.com/pdf/english/typ_UST_1206.pdf" H 6450 6550 60  0001 L CNN
F 4 "486-1686-1-ND" H 6450 6650 60  0001 L CNN "Digi-Key_PN"
F 5 "3413.0328.22" H 6450 6750 60  0001 L CNN "MPN"
F 6 "Circuit Protection" H 6450 6850 60  0001 L CNN "Category"
F 7 "Fuses" H 6450 6950 60  0001 L CNN "Family"
F 8 "https://us.schurter.com/pdf/english/typ_UST_1206.pdf" H 6450 7050 60  0001 L CNN "DK_Datasheet_Link"
F 9 "/product-detail/en/schurter-inc/3413.0328.22/486-1686-1-ND/2870095" H 6450 7150 60  0001 L CNN "DK_Detail_Page"
F 10 "FUSE BOARD MOUNT 10A 32VAC 63VDC" H 6450 7250 60  0001 L CNN "Description"
F 11 "Schurter Inc." H 6450 7350 60  0001 L CNN "Manufacturer"
F 12 "Active" H 6450 7450 60  0001 L CNN "Status"
	1    6250 6250
	1    0    0    -1  
$EndComp
Wire Wire Line
	3200 850  3300 850 
Text GLabel 3300 1000 3    50   Input ~ 0
SW_OFF
Text GLabel 3800 1000 3    50   Input ~ 0
SW_ON
Wire Wire Line
	3800 850  3800 1000
Wire Wire Line
	3300 850  3300 1000
Connection ~ 3300 850 
Wire Wire Line
	3300 850  3400 850 
Wire Wire Line
	3600 3100 3400 3100
Wire Wire Line
	3400 3200 3400 3250
Wire Wire Line
	3400 3850 3400 3800
Text GLabel 6450 6250 2    50   Input ~ 0
Neut_Fuse
Text GLabel 6450 5900 2    50   Input ~ 0
LIne_Fuse
Text Notes 5800 6400 0    50   ~ 0
250VAC 1A (5mmx20mm)
Text GLabel 6050 5900 0    50   Input ~ 0
LIne_Logic
Text GLabel 6050 6250 0    50   Input ~ 0
Neut_Logic
Text GLabel 4600 6200 2    50   Input ~ 0
LIne_Logic
Text GLabel 4600 6300 2    50   Input ~ 0
Neut_Logic
$Comp
L Power-rescue:Tensile_Board_APM4953-Tensile_Board-cache U2
U 1 1 608CA9F8
P 5100 2200
F 0 "U2" H 5244 2246 50  0000 L CNN
F 1 "APM4953" V 5244 2155 50  0000 L CNN
F 2 "Package_SO:SOP-8_3.9x4.9mm_P1.27mm" H 5800 1950 50  0001 C CNN
F 3 "" H 5800 1950 50  0001 C CNN
F 4 "C20897" H 5100 2200 50  0001 C CNN "LCSC"
	1    5100 2200
	0    -1   -1   0   
$EndComp
Wire Notes Line
	4100 500  11200 500 
Wire Notes Line
	4100 6450 11200 6450
$Comp
L power:GND #PWR0107
U 1 1 6062A026
P 4650 2300
F 0 "#PWR0107" H 4650 2050 50  0001 C CNN
F 1 "GND" H 4655 2127 50  0000 C CNN
F 2 "" H 4650 2300 50  0001 C CNN
F 3 "" H 4650 2300 50  0001 C CNN
	1    4650 2300
	1    0    0    -1  
$EndComp
Text GLabel 5900 2200 2    50   Input ~ 0
DC_IN_+
$Comp
L power:GND #PWR0108
U 1 1 6064AC09
P 5100 2500
F 0 "#PWR0108" H 5100 2250 50  0001 C CNN
F 1 "GND" H 5105 2327 50  0000 C CNN
F 2 "" H 5100 2500 50  0001 C CNN
F 3 "" H 5100 2500 50  0001 C CNN
	1    5100 2500
	1    0    0    -1  
$EndComp
Wire Wire Line
	5000 2100 4900 2100
Wire Wire Line
	4900 2100 4900 2200
Wire Wire Line
	4900 2200 4650 2200
Connection ~ 4900 2200
Wire Notes Line
	11200 500  11200 6450
Wire Wire Line
	6500 1250 6900 1250
Text GLabel 7900 1200 2    50   Input ~ 0
DC_SW_+
$Comp
L power:GND #PWR0110
U 1 1 606B843B
P 6500 1250
F 0 "#PWR0110" H 6500 1000 50  0001 C CNN
F 1 "GND" H 6505 1077 50  0000 C CNN
F 2 "" H 6500 1250 50  0001 C CNN
F 3 "" H 6500 1250 50  0001 C CNN
	1    6500 1250
	1    0    0    -1  
$EndComp
Wire Wire Line
	6600 1200 6600 1150
Wire Wire Line
	7000 1150 7000 1200
Connection ~ 7000 1200
Wire Wire Line
	7400 1150 7400 1200
Wire Wire Line
	7000 1200 7400 1200
Connection ~ 7400 1200
Wire Wire Line
	7400 1200 7800 1200
Wire Wire Line
	7800 1150 7800 1200
Connection ~ 7800 1200
Wire Wire Line
	7800 1200 7900 1200
Wire Wire Line
	7700 1250 7700 1150
Wire Wire Line
	7300 1150 7300 1250
Connection ~ 7300 1250
Wire Wire Line
	7300 1250 7700 1250
Wire Wire Line
	6900 1150 6900 1250
Connection ~ 6900 1250
Wire Wire Line
	6900 1250 7300 1250
Wire Wire Line
	6500 1150 6500 1250
Connection ~ 6500 1250
Wire Wire Line
	4350 1250 4750 1250
Wire Wire Line
	4450 1200 4500 1200
Wire Wire Line
	5650 1150 5650 1200
Connection ~ 5650 1200
Wire Wire Line
	5650 1200 5800 1200
Wire Wire Line
	5550 1150 5550 1250
Wire Wire Line
	5250 1150 5250 1200
Connection ~ 5250 1200
Wire Wire Line
	5250 1200 5650 1200
Wire Wire Line
	5150 1150 5150 1250
Connection ~ 5150 1250
Wire Wire Line
	5150 1250 5550 1250
Wire Wire Line
	4850 1150 4850 1200
Connection ~ 4850 1200
Wire Wire Line
	4850 1200 5250 1200
Wire Wire Line
	4750 1150 4750 1250
Connection ~ 4750 1250
Wire Wire Line
	4750 1250 5150 1250
Wire Wire Line
	4450 1150 4450 1200
Wire Wire Line
	4350 1150 4350 1250
Connection ~ 4350 1250
Text GLabel 9950 1800 0    50   Input ~ 0
Coil_DC
Text GLabel 10200 1950 0    50   Input ~ 0
LDO_ON_OUT
Text GLabel 10450 1500 2    50   Input ~ 0
Coil_DC
Text GLabel 9950 1500 0    50   Input ~ 0
LDO_ON_IN
$Comp
L Jumper:Jumper_3_Bridged12 JP1
U 1 1 6067AB44
P 10200 1500
F 0 "JP1" H 10200 1613 50  0000 L TNN
F 1 "Jumper_Ganged" H 10200 1613 50  0001 R BNN
F 2 "Connector_PinSocket_2.54mm:PinSocket_1x03_P2.54mm_Vertical" H 10200 1500 50  0001 C CNN
F 3 "~" H 10200 1500 50  0001 C CNN
	1    10200 1500
	1    0    0    -1  
$EndComp
$Comp
L Jumper:Jumper_3_Bridged12 JP2
U 1 1 606746DB
P 10200 1800
F 0 "JP2" H 10200 1913 50  0000 L TNN
F 1 "Jumper_Ganged" H 10200 1913 50  0001 R BNN
F 2 "Connector_PinSocket_2.54mm:PinSocket_1x03_P2.54mm_Vertical" H 10200 1800 50  0001 C CNN
F 3 "~" H 10200 1800 50  0001 C CNN
	1    10200 1800
	1    0    0    -1  
$EndComp
Text GLabel 10200 1650 0    50   Input ~ 0
SW_ON
Wire Wire Line
	6900 4550 6900 4650
Wire Wire Line
	5350 5250 5350 5350
Text Notes 4400 6150 3    50   ~ 0
L2 L1\n\n
$Comp
L Connector:Screw_Terminal_01x02 J4
U 1 1 6078D2F4
P 4400 6200
F 0 "J4" H 4318 6417 50  0000 C CNN
F 1 "3.5mmx1mm" H 4318 6326 50  0000 C CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 4400 6200 50  0001 C CNN
F 3 "~" H 4400 6200 50  0001 C CNN
	1    4400 6200
	-1   0    0    -1  
$EndComp
$Comp
L Connector:Screw_Terminal_01x02 J6
U 1 1 60799ACF
P 4450 2200
F 0 "J6" H 4368 2417 50  0000 C CNN
F 1 "3.5mmx1mm" H 4368 2326 50  0000 C CNN
F 2 "TerminalBlock_MetzConnect:TerminalBlock_MetzConnect_Type059_RT06302HBWC_1x02_P3.50mm_Horizontal" H 4450 2200 50  0001 C CNN
F 3 "~" H 4450 2200 50  0001 C CNN
	1    4450 2200
	-1   0    0    -1  
$EndComp
$Comp
L Regulator_Linear:LT1129-5.0_SOT223 U5
U 1 1 60749ACD
P 10100 5800
F 0 "U5" H 10100 6042 50  0000 C CNN
F 1 "LM2940G-12V-AA3-R" H 10100 5951 50  0000 C CNN
F 2 "Package_TO_SOT_SMD:SOT-223-3_TabPin2" H 10100 6025 50  0001 C CIN
F 3 "https://www.analog.com/media/en/technical-documentation/data-sheets/112935ff.pdf" H 10100 5750 50  0001 C CNN
F 4 "C127023" H 10100 5800 50  0001 C CNN "LCSC"
	1    10100 5800
	1    0    0    -1  
$EndComp
$Comp
L Device:C_Small C3
U 1 1 60749AD3
P 9650 6000
F 0 "C3" H 9742 6046 50  0000 L CNN
F 1 "0.47uF" H 9742 5955 50  0000 L CNN
F 2 "Capacitor_SMD:C_0603_1608Metric" H 9650 6000 50  0001 C CNN
F 3 "~" H 9650 6000 50  0001 C CNN
F 4 "C13967" H 9650 6000 50  0001 C CNN "LCSC"
	1    9650 6000
	1    0    0    -1  
$EndComp
$Comp
L Device:C_Small C6
U 1 1 60749AD9
P 10450 6000
F 0 "C6" H 10542 6046 50  0000 L CNN
F 1 "22uF" H 10542 5955 50  0000 L CNN
F 2 "Capacitor_SMD:C_0805_2012Metric" H 10450 6000 50  0001 C CNN
F 3 "~" H 10450 6000 50  0001 C CNN
F 4 "C45783" H 10450 6000 50  0001 C CNN "LCSC"
	1    10450 6000
	1    0    0    -1  
$EndComp
Wire Wire Line
	9800 5800 9650 5800
Wire Wire Line
	9650 5800 9650 5900
Wire Wire Line
	10400 5800 10450 5800
Wire Wire Line
	10450 5800 10450 5900
Wire Wire Line
	10450 6100 10100 6100
Wire Wire Line
	9650 6100 10100 6100
Connection ~ 10100 6100
$Comp
L power:GND #PWR0111
U 1 1 60749AE6
P 10100 6150
F 0 "#PWR0111" H 10100 5900 50  0001 C CNN
F 1 "GND" H 10105 5977 50  0000 C CNN
F 2 "" H 10100 6150 50  0001 C CNN
F 3 "" H 10100 6150 50  0001 C CNN
	1    10100 6150
	1    0    0    -1  
$EndComp
Wire Wire Line
	10100 6150 10100 6100
Text GLabel 9650 5800 0    50   Input ~ 0
LDO_AC_IN
Text GLabel 10450 5800 2    50   Input ~ 0
LDO_AC_OUT
Text GLabel 9950 3200 0    50   Input ~ 0
Coil_AC
Text GLabel 10200 3350 0    50   Input ~ 0
LDO_AC_OUT
Text GLabel 10450 2900 2    50   Input ~ 0
Coil_AC
Text GLabel 9950 2900 0    50   Input ~ 0
LDO_AC_IN
$Comp
L Jumper:Jumper_3_Bridged12 JP5
U 1 1 607DAC8F
P 10200 2900
F 0 "JP5" H 10200 3013 50  0000 L TNN
F 1 "Jumper_Ganged" H 10200 3013 50  0001 R BNN
F 2 "Connector_PinSocket_2.54mm:PinSocket_1x03_P2.54mm_Vertical" H 10200 2900 50  0001 C CNN
F 3 "~" H 10200 2900 50  0001 C CNN
	1    10200 2900
	1    0    0    -1  
$EndComp
$Comp
L Jumper:Jumper_3_Bridged12 JP6
U 1 1 607DAC95
P 10200 3200
F 0 "JP6" H 10200 3313 50  0000 L TNN
F 1 "Jumper_Ganged" H 10200 3313 50  0001 R BNN
F 2 "Connector_PinSocket_2.54mm:PinSocket_1x03_P2.54mm_Vertical" H 10200 3200 50  0001 C CNN
F 3 "~" H 10200 3200 50  0001 C CNN
	1    10200 3200
	1    0    0    -1  
$EndComp
Text GLabel 10200 3050 0    50   Input ~ 0
ESD_+
$Comp
L Power-rescue:3413_0328_22-dk_Fuses F1
U 1 1 60813499
P 5700 2200
F 0 "F1" H 5700 2447 60  0000 C CNN
F 1 "Wurth 696106003002‎" H 5700 2341 60  0000 C CNN
F 2 "MaD_Power_Board:732-11374-ND" H 5900 2400 60  0001 L CNN
F 3 "https://us.schurter.com/pdf/english/typ_UST_1206.pdf" H 5900 2500 60  0001 L CNN
F 4 "486-1686-1-ND" H 5900 2600 60  0001 L CNN "Digi-Key_PN"
F 5 "3413.0328.22" H 5900 2700 60  0001 L CNN "MPN"
F 6 "Circuit Protection" H 5900 2800 60  0001 L CNN "Category"
F 7 "Fuses" H 5900 2900 60  0001 L CNN "Family"
F 8 "https://us.schurter.com/pdf/english/typ_UST_1206.pdf" H 5900 3000 60  0001 L CNN "DK_Datasheet_Link"
F 9 "/product-detail/en/schurter-inc/3413.0328.22/486-1686-1-ND/2870095" H 5900 3100 60  0001 L CNN "DK_Detail_Page"
F 10 "FUSE BOARD MOUNT 10A 32VAC 63VDC" H 5900 3200 60  0001 L CNN "Description"
F 11 "Schurter Inc." H 5900 3300 60  0001 L CNN "Manufacturer"
F 12 "Active" H 5900 3400 60  0001 L CNN "Status"
	1    5700 2200
	1    0    0    -1  
$EndComp
Wire Wire Line
	5500 2200 5300 2200
Text GLabel 9650 3950 0    50   Input ~ 0
LDO_ON_IN
Wire Wire Line
	9650 3950 9650 4050
Wire Wire Line
	9800 3950 9650 3950
$Comp
L Device:C_Small C1
U 1 1 605C2649
P 9650 4150
F 0 "C1" H 9742 4196 50  0000 L CNN
F 1 "0.47uF" H 9742 4105 50  0000 L CNN
F 2 "Capacitor_SMD:C_0603_1608Metric" H 9650 4150 50  0001 C CNN
F 3 "~" H 9650 4150 50  0001 C CNN
F 4 "C13967" H 9650 4150 50  0001 C CNN "LCSC"
	1    9650 4150
	1    0    0    -1  
$EndComp
$Comp
L Regulator_Linear:LT1129-5.0_SOT223 U3
U 1 1 608D00D6
P 10100 3950
F 0 "U3" H 10100 4192 50  0000 C CNN
F 1 "LM2940G-12V-AA3-R" H 10100 4101 50  0000 C CNN
F 2 "Package_TO_SOT_SMD:SOT-223-3_TabPin2" H 10100 4175 50  0001 C CIN
F 3 "https://www.analog.com/media/en/technical-documentation/data-sheets/112935ff.pdf" H 10100 3900 50  0001 C CNN
F 4 "C127023" H 10100 3950 50  0001 C CNN "LCSC"
	1    10100 3950
	1    0    0    -1  
$EndComp
$Comp
L Device:C_Small C4
U 1 1 605C6E6C
P 10450 4150
F 0 "C4" H 10542 4196 50  0000 L CNN
F 1 "22uF" H 10542 4105 50  0000 L CNN
F 2 "Capacitor_SMD:C_0805_2012Metric" H 10450 4150 50  0001 C CNN
F 3 "~" H 10450 4150 50  0001 C CNN
F 4 "C45783" H 10450 4150 50  0001 C CNN "LCSC"
	1    10450 4150
	1    0    0    -1  
$EndComp
Wire Wire Line
	10400 3950 10450 3950
Wire Wire Line
	10450 3950 10450 4050
Wire Wire Line
	10450 4250 10100 4250
Wire Wire Line
	9650 4250 10100 4250
Connection ~ 10100 4250
$Comp
L power:GND #PWR0112
U 1 1 605D51F4
P 10100 4300
F 0 "#PWR0112" H 10100 4050 50  0001 C CNN
F 1 "GND" H 10105 4127 50  0000 C CNN
F 2 "" H 10100 4300 50  0001 C CNN
F 3 "" H 10100 4300 50  0001 C CNN
	1    10100 4300
	1    0    0    -1  
$EndComp
Wire Wire Line
	10100 4300 10100 4250
Text GLabel 10450 3950 2    50   Input ~ 0
LDO_ON_OUT
Text GLabel 8300 2300 2    50   Input ~ 0
Coil_DC
Wire Wire Line
	8000 1650 7950 1650
Wire Wire Line
	7950 2100 8000 2100
Wire Wire Line
	7250 2100 7350 2100
Wire Wire Line
	8000 2100 8000 1650
Wire Wire Line
	7250 2100 7250 1650
Text GLabel 7950 2700 2    50   Input ~ 0
DC_SW_+
$Comp
L Diode:B140-E3 D4
U 1 1 605EB005
P 7800 1650
F 0 "D4" H 7800 1867 50  0000 C CNN
F 1 "SS14 DO-214 AC (40V 1A)" H 7800 1776 50  0000 R CNN
F 2 "Diode_SMD:D_SMA" H 7800 1475 50  0001 C CNN
F 3 "http://www.vishay.com/docs/88946/b120.pdf" H 7800 1650 50  0001 C CNN
F 4 "C2480" H 7800 1650 50  0001 C CNN "LCSC"
	1    7800 1650
	-1   0    0    1   
$EndComp
$Comp
L Power-rescue:MMSZ5231B-7-F-dk_Diodes-Zener-Single Z1
U 1 1 605EAFFE
P 7450 1650
F 0 "Z1" H 7450 1912 60  0000 C CNN
F 1 "MM1Z15 SOD-123" H 8050 1750 60  0000 R BNN
F 2 "digikey-footprints:SOD-123" H 7650 1850 60  0001 L CNN
F 3 "https://www.diodes.com/assets/Datasheets/ds18010.pdf" H 7650 1950 60  0001 L CNN
F 4 "MMSZ5231B-FDICT-ND" H 7650 2050 60  0001 L CNN "Digi-Key_PN"
F 5 "MMSZ5231B-7-F" H 7650 2150 60  0001 L CNN "MPN"
F 6 "Discrete Semiconductor Products" H 7650 2250 60  0001 L CNN "Category"
F 7 "Diodes - Zener - Single" H 7650 2350 60  0001 L CNN "Family"
F 8 "https://www.diodes.com/assets/Datasheets/ds18010.pdf" H 7650 2450 60  0001 L CNN "DK_Datasheet_Link"
F 9 "/product-detail/en/diodes-incorporated/MMSZ5231B-7-F/MMSZ5231B-FDICT-ND/755506" H 7650 2550 60  0001 L CNN "DK_Detail_Page"
F 10 "DIODE ZENER 5.1V 500MW SOD123" H 7650 2650 60  0001 L CNN "Description"
F 11 "Diodes Incorporated" H 7650 2750 60  0001 L CNN "Manufacturer"
F 12 "Active" H 7650 2850 60  0001 L CNN "Status"
F 13 "C86235" H 7450 1650 50  0001 C CNN "LCSC"
	1    7450 1650
	-1   0    0    1   
$EndComp
$Comp
L Power-rescue:G5V-2-DC12-dk_Signal-Relays-Up-to-2-Amps RLY1
U 1 1 605CB725
P 7650 2500
F 0 "RLY1" H 8137 2546 50  0000 L CNN
F 1 "Axicom V23105A5003A201" V 8137 2455 50  0000 L CNN
F 2 "digikey-footprints:Relay_THT_G5V-2" H 7850 2700 50  0001 L CNN
F 3 "https://omronfs.omron.com/en_US/ecb/products/pdf/en-g5v_2.pdf" H 7850 2800 60  0001 L CNN
F 4 "Z768-ND" H 7850 2900 60  0001 L CNN "Digi-Key_PN"
F 5 "G5V-2-DC12" H 7850 3000 60  0001 L CNN "MPN"
F 6 "Relays" H 7850 3100 60  0001 L CNN "Category"
F 7 "Signal Relays, Up to 2 Amps" H 7850 3200 60  0001 L CNN "Family"
F 8 "https://omronfs.omron.com/en_US/ecb/products/pdf/en-g5v_2.pdf" H 7850 3300 60  0001 L CNN "DK_Datasheet_Link"
F 9 "/product-detail/en/omron-electronics-inc-emc-div/G5V-2-DC12/Z768-ND/87821" H 7850 3400 60  0001 L CNN "DK_Detail_Page"
F 10 "RELAY GEN PURPOSE DPDT 2A 12VDC" H 7850 3500 60  0001 L CNN "Description"
F 11 "Omron Electronics Inc-EMC Div" H 7850 3600 60  0001 L CNN "Manufacturer"
F 12 "Active" H 7850 3700 60  0001 L CNN "Status"
	1    7650 2500
	0    1    1    0   
$EndComp
Text GLabel 8250 4000 2    50   Input ~ 0
Coil_AC
Wire Wire Line
	7550 4000 7550 3450
Wire Wire Line
	7650 4000 7550 4000
Text GLabel 8250 4900 2    50   Input ~ 0
Neut_Servo
Text GLabel 8250 4500 2    50   Input ~ 0
Line_Servo
Text GLabel 7650 4800 0    50   Input ~ 0
Neut_IN
Text GLabel 7650 4400 0    50   Input ~ 0
Line_IN
Text GLabel 7550 4000 0    50   Input ~ 0
ESD_-
$Comp
L Diode:B140-E3 D5
U 1 1 605D6458
P 8100 3450
F 0 "D5" H 8100 3667 50  0000 C CNN
F 1 "SS14 DO-214 AC (40V 1A)" H 8100 3576 50  0000 R TNN
F 2 "Diode_SMD:D_SMA" H 8100 3275 50  0001 C CNN
F 3 "http://www.vishay.com/docs/88946/b120.pdf" H 8100 3450 50  0001 C CNN
F 4 "C2480" H 8100 3450 50  0001 C CNN "LCSC"
	1    8100 3450
	-1   0    0    1   
$EndComp
Wire Wire Line
	8250 4000 8250 3800
$Comp
L Power-rescue:MMSZ5231B-7-F-dk_Diodes-Zener-Single Z2
U 1 1 605D3AF5
P 7750 3450
F 0 "Z2" H 7750 3712 60  0000 C CNN
F 1 "MM1Z15 SOD-123" H 7750 3606 60  0000 R BNN
F 2 "digikey-footprints:SOD-123" H 7950 3650 60  0001 L CNN
F 3 "https://www.diodes.com/assets/Datasheets/ds18010.pdf" H 7950 3750 60  0001 L CNN
F 4 "MMSZ5231B-FDICT-ND" H 7950 3850 60  0001 L CNN "Digi-Key_PN"
F 5 "MMSZ5231B-7-F" H 7950 3950 60  0001 L CNN "MPN"
F 6 "Discrete Semiconductor Products" H 7950 4050 60  0001 L CNN "Category"
F 7 "Diodes - Zener - Single" H 7950 4150 60  0001 L CNN "Family"
F 8 "https://www.diodes.com/assets/Datasheets/ds18010.pdf" H 7950 4250 60  0001 L CNN "DK_Datasheet_Link"
F 9 "/product-detail/en/diodes-incorporated/MMSZ5231B-7-F/MMSZ5231B-FDICT-ND/755506" H 7950 4350 60  0001 L CNN "DK_Detail_Page"
F 10 "DIODE ZENER 5.1V 500MW SOD123" H 7950 4450 60  0001 L CNN "Description"
F 11 "Diodes Incorporated" H 7950 4550 60  0001 L CNN "Manufacturer"
F 12 "Active" H 7950 4650 60  0001 L CNN "Status"
F 13 "C86235" H 7750 3450 50  0001 C CNN "LCSC"
	1    7750 3450
	-1   0    0    1   
$EndComp
$Comp
L Relay:RTE4xxxx K1
U 1 1 605B9C54
P 7950 4400
F 0 "K1" H 8580 4446 50  0000 L CNN
F 1 "Schrack RTE44012" V 8580 4355 50  0000 L CNN
F 2 "Relay_THT:Relay_DPST_Schrack-RT2-FormA_RM5mm" H 7950 4400 50  0001 C CNN
F 3 "http://www.te.com/commerce/DocumentDelivery/DDEController?Action=showdoc&DocId=Data+Sheet%7FRT2%7F1014%7Fpdf%7FEnglish%7FENG_DS_RT2_1014.pdf%7F6-1393243-3" H 7950 4400 50  0001 C CNN
	1    7950 4400
	0    1    1    0   
$EndComp
Wire Notes Line
	8750 4150 8750 6450
Text Notes 9700 3550 0    50   ~ 0
LDO 12V  or  VIN = 12V
Wire Notes Line
	9400 1350 9400 3600
Wire Notes Line
	9400 3600 10900 3600
Wire Notes Line
	10900 3600 10900 1350
Wire Notes Line
	10900 1350 9400 1350
Wire Notes Line
	8750 4150 4100 4150
Wire Notes Line
	4100 500  4100 6450
Wire Wire Line
	7950 2300 8000 2300
Wire Wire Line
	8000 2300 8000 2100
Connection ~ 8000 2100
$Comp
L power:GND #PWR0113
U 1 1 6095BFED
P 7250 2100
F 0 "#PWR0113" H 7250 1850 50  0001 C CNN
F 1 "GND" H 7255 1927 50  0000 C CNN
F 2 "" H 7250 2100 50  0001 C CNN
F 3 "" H 7250 2100 50  0001 C CNN
	1    7250 2100
	1    0    0    -1  
$EndComp
Connection ~ 7250 2100
$Comp
L Diode:B140-E3 D6
U 1 1 60967C98
P 8150 2300
F 0 "D6" H 8150 2517 50  0000 C CNN
F 1 "SS14 DO-214 AC (40V 1A)" H 8150 2426 50  0000 R CNN
F 2 "Diode_SMD:D_SMA" H 8150 2125 50  0001 C CNN
F 3 "http://www.vishay.com/docs/88946/b120.pdf" H 8150 2300 50  0001 C CNN
F 4 "C2480" H 8150 2300 50  0001 C CNN "LCSC"
	1    8150 2300
	1    0    0    1   
$EndComp
Connection ~ 8000 2300
Text Notes 5300 2350 0    50   ~ 0
250VAC 5A (5mmx20mm)
$Comp
L Device:LED D7
U 1 1 60989E4E
P 8750 2250
F 0 "D7" V 8789 2132 50  0000 R CNN
F 1 "BLU" V 8698 2132 50  0000 R CNN
F 2 "LED_SMD:LED_0603_1608Metric" H 8750 2250 50  0001 C CNN
F 3 "~" H 8750 2250 50  0001 C CNN
F 4 "C72041" H 8750 2250 50  0001 C CNN "LCSC"
	1    8750 2250
	0    -1   -1   0   
$EndComp
$Comp
L Device:R_Small R3
U 1 1 6098D750
P 8750 2500
F 0 "R3" H 8809 2546 50  0000 L CNN
F 1 "1k" H 8809 2455 50  0000 L CNN
F 2 "Resistor_SMD:R_0603_1608Metric" H 8750 2500 50  0001 C CNN
F 3 "~" H 8750 2500 50  0001 C CNN
F 4 "C21190" H 8750 2500 50  0001 C CNN "LCSC"
	1    8750 2500
	1    0    0    -1  
$EndComp
$Comp
L power:GND #PWR0114
U 1 1 6098DECB
P 8750 2600
F 0 "#PWR0114" H 8750 2350 50  0001 C CNN
F 1 "GND" H 8755 2427 50  0000 C CNN
F 2 "" H 8750 2600 50  0001 C CNN
F 3 "" H 8750 2600 50  0001 C CNN
	1    8750 2600
	1    0    0    -1  
$EndComp
$Comp
L Device:LED D1
U 1 1 6099CFDE
P 4500 1350
F 0 "D1" V 4539 1232 50  0000 R CNN
F 1 "GRN" V 4448 1232 50  0000 R CNN
F 2 "LED_SMD:LED_0603_1608Metric" H 4500 1350 50  0001 C CNN
F 3 "~" H 4500 1350 50  0001 C CNN
F 4 "C72043" H 4500 1350 50  0001 C CNN "LCSC"
	1    4500 1350
	0    -1   -1   0   
$EndComp
$Comp
L Device:R_Small R1
U 1 1 6099CFE4
P 4500 1600
F 0 "R1" H 4559 1646 50  0000 L CNN
F 1 "1k" H 4559 1555 50  0000 L CNN
F 2 "Resistor_SMD:R_0603_1608Metric" H 4500 1600 50  0001 C CNN
F 3 "~" H 4500 1600 50  0001 C CNN
F 4 "C21190" H 4500 1600 50  0001 C CNN "LCSC"
	1    4500 1600
	1    0    0    -1  
$EndComp
$Comp
L power:GND #PWR0115
U 1 1 6099CFEA
P 4500 1700
F 0 "#PWR0115" H 4500 1450 50  0001 C CNN
F 1 "GND" H 4505 1527 50  0000 C CNN
F 2 "" H 4500 1700 50  0001 C CNN
F 3 "" H 4500 1700 50  0001 C CNN
	1    4500 1700
	1    0    0    -1  
$EndComp
Wire Wire Line
	6600 1200 6700 1200
$Comp
L Device:LED D8
U 1 1 609A28CB
P 8850 3950
F 0 "D8" V 8889 3832 50  0000 R CNN
F 1 "BLU" V 8798 3832 50  0000 R CNN
F 2 "LED_SMD:LED_0603_1608Metric" H 8850 3950 50  0001 C CNN
F 3 "~" H 8850 3950 50  0001 C CNN
F 4 "C72041" H 8850 3950 50  0001 C CNN "LCSC"
	1    8850 3950
	0    -1   -1   0   
$EndComp
$Comp
L Device:R_Small R4
U 1 1 609A28D1
P 8850 4200
F 0 "R4" H 8909 4246 50  0000 L CNN
F 1 "1k" H 8909 4155 50  0000 L CNN
F 2 "Resistor_SMD:R_0603_1608Metric" H 8850 4200 50  0001 C CNN
F 3 "~" H 8850 4200 50  0001 C CNN
F 4 "C21190" H 8850 4200 50  0001 C CNN "LCSC"
	1    8850 4200
	1    0    0    -1  
$EndComp
$Comp
L power:GND #PWR0116
U 1 1 609A28D7
P 8850 4300
F 0 "#PWR0116" H 8850 4050 50  0001 C CNN
F 1 "GND" H 8855 4127 50  0000 C CNN
F 2 "" H 8850 4300 50  0001 C CNN
F 3 "" H 8850 4300 50  0001 C CNN
	1    8850 4300
	1    0    0    -1  
$EndComp
Wire Wire Line
	8750 2100 8000 2100
Wire Wire Line
	8850 3800 8250 3800
Connection ~ 8250 3800
Wire Wire Line
	8250 3800 8250 3450
$Comp
L Device:LED D2
U 1 1 609ADD99
P 6700 1350
F 0 "D2" V 6739 1232 50  0000 R CNN
F 1 "RED" V 6648 1232 50  0000 R CNN
F 2 "LED_SMD:LED_0603_1608Metric" H 6700 1350 50  0001 C CNN
F 3 "~" H 6700 1350 50  0001 C CNN
F 4 "C2286" H 6700 1350 50  0001 C CNN "LCSC"
	1    6700 1350
	0    -1   -1   0   
$EndComp
$Comp
L Device:R_Small R2
U 1 1 609ADD9F
P 6700 1600
F 0 "R2" H 6759 1646 50  0000 L CNN
F 1 "1k" H 6759 1555 50  0000 L CNN
F 2 "Resistor_SMD:R_0603_1608Metric" H 6700 1600 50  0001 C CNN
F 3 "~" H 6700 1600 50  0001 C CNN
F 4 "C21190" H 6700 1600 50  0001 C CNN "LCSC"
	1    6700 1600
	1    0    0    -1  
$EndComp
$Comp
L power:GND #PWR0117
U 1 1 609ADDA5
P 6700 1700
F 0 "#PWR0117" H 6700 1450 50  0001 C CNN
F 1 "GND" H 6705 1527 50  0000 C CNN
F 2 "" H 6700 1700 50  0001 C CNN
F 3 "" H 6700 1700 50  0001 C CNN
	1    6700 1700
	1    0    0    -1  
$EndComp
Connection ~ 6700 1200
Wire Wire Line
	6700 1200 7000 1200
Connection ~ 4500 1200
Wire Wire Line
	4500 1200 4850 1200
Text Notes 8600 2050 0    50   ~ 0
IO Power
Text Notes 8750 3750 0    50   ~ 0
Servo
Text GLabel 5900 4650 0    50   Input ~ 0
Neut_DC_PWR
Text GLabel 5900 4450 0    50   Input ~ 0
Line_DC_PWR
$Comp
L Mechanical:MountingHole_Pad H1
U 1 1 60730707
P 5850 3100
F 0 "H1" H 5950 3149 50  0000 L CNN
F 1 "MountingHole_Pad" H 5950 3058 50  0000 L CNN
F 2 "MountingHole:MountingHole_3.2mm_M3_Pad" H 5850 3100 50  0001 C CNN
F 3 "~" H 5850 3100 50  0001 C CNN
	1    5850 3100
	1    0    0    -1  
$EndComp
$Comp
L Mechanical:MountingHole_Pad H2
U 1 1 607312AD
P 6300 3150
F 0 "H2" H 6400 3199 50  0000 L CNN
F 1 "MountingHole_Pad" H 6400 3108 50  0000 L CNN
F 2 "MountingHole:MountingHole_3.2mm_M3_Pad" H 6300 3150 50  0001 C CNN
F 3 "~" H 6300 3150 50  0001 C CNN
	1    6300 3150
	1    0    0    -1  
$EndComp
$Comp
L Mechanical:MountingHole_Pad H4
U 1 1 6073149D
P 8100 5950
F 0 "H4" H 8200 5999 50  0000 L CNN
F 1 "MountingHole_Pad" H 8200 5908 50  0000 L CNN
F 2 "MountingHole:MountingHole_3.2mm_M3_Pad" H 8100 5950 50  0001 C CNN
F 3 "~" H 8100 5950 50  0001 C CNN
	1    8100 5950
	1    0    0    -1  
$EndComp
$Comp
L Mechanical:MountingHole_Pad H3
U 1 1 6073177F
P 7650 5950
F 0 "H3" H 7750 5999 50  0000 L CNN
F 1 "MountingHole_Pad" H 7750 5908 50  0000 L CNN
F 2 "MountingHole:MountingHole_3.2mm_M3_Pad" H 7650 5950 50  0001 C CNN
F 3 "~" H 7650 5950 50  0001 C CNN
	1    7650 5950
	1    0    0    -1  
$EndComp
$Comp
L power:Earth_Protective #PWR0118
U 1 1 60731BB1
P 7650 6050
F 0 "#PWR0118" H 7900 5800 50  0001 C CNN
F 1 "Earth_Protective" H 8100 5900 50  0001 C CNN
F 2 "" H 7650 5950 50  0001 C CNN
F 3 "~" H 7650 5950 50  0001 C CNN
	1    7650 6050
	1    0    0    -1  
$EndComp
$Comp
L power:Earth_Protective #PWR0119
U 1 1 60732509
P 8100 6050
F 0 "#PWR0119" H 8350 5800 50  0001 C CNN
F 1 "Earth_Protective" H 8550 5900 50  0001 C CNN
F 2 "" H 8100 5950 50  0001 C CNN
F 3 "~" H 8100 5950 50  0001 C CNN
	1    8100 6050
	1    0    0    -1  
$EndComp
$Comp
L power:GND #PWR0120
U 1 1 60735A4C
P 5850 3200
F 0 "#PWR0120" H 5850 2950 50  0001 C CNN
F 1 "GND" H 5855 3027 50  0000 C CNN
F 2 "" H 5850 3200 50  0001 C CNN
F 3 "" H 5850 3200 50  0001 C CNN
	1    5850 3200
	1    0    0    -1  
$EndComp
$Comp
L power:GND #PWR0121
U 1 1 60735DCF
P 6300 3250
F 0 "#PWR0121" H 6300 3000 50  0001 C CNN
F 1 "GND" H 6305 3077 50  0000 C CNN
F 2 "" H 6300 3250 50  0001 C CNN
F 3 "" H 6300 3250 50  0001 C CNN
	1    6300 3250
	1    0    0    -1  
$EndComp
Text GLabel 7050 2400 0    50   Input ~ 0
Latch_DC
$Comp
L Diode:B140-E3 D3
U 1 1 60961E7B
P 7200 2400
F 0 "D3" H 7200 2617 50  0000 C CNN
F 1 "SS14 DO-214 AC (40V 1A)" H 7200 2526 50  0000 R CNN
F 2 "Diode_SMD:D_SMA" H 7200 2225 50  0001 C CNN
F 3 "http://www.vishay.com/docs/88946/b120.pdf" H 7200 2400 50  0001 C CNN
F 4 "C2480" H 7200 2400 50  0001 C CNN "LCSC"
	1    7200 2400
	-1   0    0    1   
$EndComp
Text GLabel 10450 4850 2    50   Input ~ 0
LDO_OFF_OUT
Text GLabel 9650 4850 0    50   Input ~ 0
LDO_OFF_IN
Wire Wire Line
	10100 5200 10100 5150
$Comp
L power:GND #PWR0109
U 1 1 606CDA54
P 10100 5200
F 0 "#PWR0109" H 10100 4950 50  0001 C CNN
F 1 "GND" H 10105 5027 50  0000 C CNN
F 2 "" H 10100 5200 50  0001 C CNN
F 3 "" H 10100 5200 50  0001 C CNN
	1    10100 5200
	1    0    0    -1  
$EndComp
Wire Wire Line
	9650 5150 10100 5150
Connection ~ 10100 5150
Wire Wire Line
	10450 5150 10100 5150
Wire Wire Line
	10450 4850 10450 4950
Wire Wire Line
	10400 4850 10450 4850
Wire Wire Line
	9650 4850 9650 4950
Wire Wire Line
	9800 4850 9650 4850
$Comp
L Device:C_Small C5
U 1 1 606CDA47
P 10450 5050
F 0 "C5" H 10542 5096 50  0000 L CNN
F 1 "22uF" H 10542 5005 50  0000 L CNN
F 2 "Capacitor_SMD:C_0805_2012Metric" H 10450 5050 50  0001 C CNN
F 3 "~" H 10450 5050 50  0001 C CNN
F 4 "C45783" H 10450 5050 50  0001 C CNN "LCSC"
	1    10450 5050
	1    0    0    -1  
$EndComp
$Comp
L Device:C_Small C2
U 1 1 606CDA41
P 9650 5050
F 0 "C2" H 9742 5096 50  0000 L CNN
F 1 "0.47uF" H 9742 5005 50  0000 L CNN
F 2 "Capacitor_SMD:C_0603_1608Metric" H 9650 5050 50  0001 C CNN
F 3 "~" H 9650 5050 50  0001 C CNN
F 4 "C13967" H 9650 5050 50  0001 C CNN "LCSC"
	1    9650 5050
	1    0    0    -1  
$EndComp
$Comp
L Regulator_Linear:LT1129-5.0_SOT223 U4
U 1 1 606CDA3B
P 10100 4850
F 0 "U4" H 10100 5092 50  0000 C CNN
F 1 "LM2940G-12V-AA3-R" H 10100 5001 50  0000 C CNN
F 2 "Package_TO_SOT_SMD:SOT-223-3_TabPin2" H 10100 5075 50  0001 C CIN
F 3 "https://www.analog.com/media/en/technical-documentation/data-sheets/112935ff.pdf" H 10100 4800 50  0001 C CNN
F 4 "C127023" H 10100 4850 50  0001 C CNN "LCSC"
	1    10100 4850
	1    0    0    -1  
$EndComp
$Comp
L Jumper:Jumper_3_Bridged12 JP4
U 1 1 606AA1E1
P 10200 2500
F 0 "JP4" H 10200 2613 50  0000 L TNN
F 1 "Jumper_Ganged" H 10200 2613 50  0001 R BNN
F 2 "Connector_PinSocket_2.54mm:PinSocket_1x03_P2.54mm_Vertical" H 10200 2500 50  0001 C CNN
F 3 "~" H 10200 2500 50  0001 C CNN
	1    10200 2500
	1    0    0    -1  
$EndComp
$Comp
L Jumper:Jumper_3_Bridged12 JP3
U 1 1 606AA1E7
P 10200 2200
F 0 "JP3" H 10200 2313 50  0000 L TNN
F 1 "Jumper_Ganged" H 10200 2313 50  0001 R BNN
F 2 "Connector_PinSocket_2.54mm:PinSocket_1x03_P2.54mm_Vertical" H 10200 2200 50  0001 C CNN
F 3 "~" H 10200 2200 50  0001 C CNN
	1    10200 2200
	1    0    0    -1  
$EndComp
Text GLabel 9950 2200 0    50   Input ~ 0
LDO_OFF_IN
Text GLabel 10450 2200 2    50   Input ~ 0
Latch_DC
Text GLabel 10200 2650 0    50   Input ~ 0
LDO_OFF_OUT
Text GLabel 9950 2500 0    50   Input ~ 0
Latch_DC
Text GLabel 7350 2800 0    50   Input ~ 0
SW_OFF
Text GLabel 10200 2350 0    50   Input ~ 0
SW_OFF
Text Notes 4200 6250 1    50   ~ 0
DYN4 T4
$EndSCHEMATC
