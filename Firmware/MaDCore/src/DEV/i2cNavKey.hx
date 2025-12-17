
//
//    FILE: i2cNavKey.h
// VERSION: 0.1..
// PURPOSE: Libreary for the i2c NavKey board with arduinp
// LICENSE: GPL v3 (http://www.gnu.org/licenses/gpl.html)
//
// DATASHEET:
//
//     URL:
//
// AUTHOR:
// Simone Caron
//

#ifndef i2cNavKey_H
#define i2cNavKey_H

#include "stdbool.h"
#include <stdint.h>
#include <stdlib.h>
#include "I2C.h"

/* NavKey configuration bit. Use with GCONF */
enum GCONF_PARAMETER
{
	FLOAT_DATA = 0x01,
	INT_DATA = 0x00,
	WRAP_ENABLE = 0x02,
	WRAP_DISABLE = 0x00,
	DIRE_LEFT = 0x04,
	DIRE_RIGHT = 0x00,
	IPUP_DISABLE = 0x08,
	IPUP_ENABLE = 0x00,
	CLK_STRECH_ENABLE = 0x10,
	CLK_STRECH_DISABLE = 0x00,
	EEPROM_BANK1 = 0x20,
	EEPROM_BANK2 = 0x00,
	RESET = 0x80,
};

union Data_v
{
	float fval;
	uint16_t wval;
	int32_t val;
	uint8_t bval[4];
};
typedef struct navkeystatus_t
{
	uint16_t raw;
	bool UPR, UPP, DNR, DNP, RTR, RTP, LTR, LTP;
	bool CTRR, CTRP, CTRDP;
	bool RINC, RDEC, RMAX, RMIN;
	int GP1POS, GP1NEG, GP2POS, GP2NEG, GP3POS, GP3NEG;
	int FADEINT;
} NavKeyStatus;

typedef struct navkey_t
{
	I2C i2cBus;
	int scl;
	int sda;
	NavKeyStatus status;
	uint8_t _add;
	uint16_t _stat;
	uint8_t _stat2;
	uint8_t _statfade;
	uint8_t _gconf;
	union Data_v _tem_data;
} NavKey;

void navkey_begin(NavKey *navkey, int scl, int sda, uint8_t addr, uint8_t conf);
void navkey_reset(NavKey *navkey);
void navkey_auto_config_interrupt(NavKey *navkey);

/**    Read functions   **/
void navkey_update_status(NavKey *navkey);
/** Configuration function **/
uint8_t navkey_read_gp1_conf(NavKey *navkey);
uint8_t navkey_read_gp2_conf(NavKey *navkey);
uint8_t navkey_read_gp3_conf(NavKey *navkey);
uint16_t navkey_read_interrupt_config(NavKey *navkey);

/** Status function **/
uint16_t navkey_read_status(NavKey *navkey);

uint8_t navkey_read_int2(NavKey *navkey);

uint8_t navkey_read_fade_status(NavKey *navkey);

/** NavKey functions **/
float navkey_read_counter_float(NavKey *navkey);
int32_t navkey_read_counter_long(NavKey *navkey);
int16_t navkey_read_counter_int(NavKey *navkey);
int8_t navkey_read_counter_byte(NavKey *navkey);

int32_t navkey_read_max(NavKey *navkey);
float navkey_read_max_float(NavKey *navkey);

int32_t navkey_read_min(NavKey *navkey);
float navkey_read_min_float(NavKey *navkey);

int32_t navkey_readStep(NavKey *navkey);
float navkey_read_step_float(NavKey *navkey);

/** GP LED Functions **/
uint8_t navkey_read_gp1(NavKey *navkey);
uint8_t navkey_read_gp2(NavKey *navkey);
uint8_t navkey_read_gp3(NavKey *navkey);

/** Timing registers **/
uint8_t navkey_read_double_push_period(NavKey *navkey);
uint8_t navkey_read_fade_gp(NavKey *navkey);

/** EEPROM register **/
uint8_t navkey_read_eeprom(NavKey *navkey, uint8_t add);

/** **/
uint8_t navkey_read_id_code(NavKey *navkey);
uint8_t navkey_read_version(NavKey *navkey);

/******    Write functions   ********/
void navkey_write_gp1_conf(NavKey *navkey, uint8_t gp1);
void navkey_write_gp2_conf(NavKey *navkey, uint8_t gp2);
void navkey_write_gp3_conf(NavKey *navkey, uint8_t gp3);
void navkey_write_interrupt_config(NavKey *navkey, uint16_t interrupt);

/** NavKey functions **/
void navkey_write_counter(NavKey *navkey, int counter);

void navkey_write_max(NavKey *navkey, int max);

void navkey_write_min(NavKey *navkey, int min);

void navkey_write_step(NavKey *navkey, int step);

/** GP LED Functions **/
void navkey_write_gp1(NavKey *navkey, uint8_t gp1);
void navkey_write_gp2(NavKey *navkey, uint8_t gp2);
void navkey_write_gp3(NavKey *navkey, uint8_t gp3);

/** Timing registers **/
void navkey_write_double_push_period(NavKey *navkey, uint8_t dperiod);
void navkey_write_fade_gp(NavKey *navkey, uint8_t fade);

void navkey_write_gamma_gp1(NavKey *navkey, uint8_t gamma);
void navkey_write_gamma_gp2(NavKey *navkey, uint8_t gamma);
void navkey_write_gamma_gp3(NavKey *navkey, uint8_t gamma);

/** EEPROM register **/
void navkey_writeEEPROM(NavKey *navkey, uint8_t add, uint8_t data);

void navkey_write8(NavKey *navkey, uint8_t reg, uint8_t data);
void navkey_write16(NavKey *navkey, uint8_t reg, uint16_t data);
void navkey_write32(NavKey *navkey, uint8_t reg, int32_t data);
void navkey_write_float(NavKey *navkey, uint8_t reg, float data);
void navkey_write24(NavKey *navkey, uint8_t reg, uint32_t data);

#endif
