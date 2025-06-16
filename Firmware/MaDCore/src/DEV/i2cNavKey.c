//
//    FILE: i2cNavKey.h
// VERSION: 0.1..
// PURPOSE: Library for I2C NavKey V2 board with Arduino
// LICENSE: GPL v3 (http://www.gnu.org/licenses/gpl.html)
//
// DATASHEET:
//
//     URL:
//
// AUTHOR:
// Simone Caron
//

#include "i2cNavKey.h"
#include <propeller2.h>
enum I2C_Register
{
  REG_GCONF = 0x00,
  REG_GP1CONF = 0x01,
  REG_GP2CONF = 0x02,
  REG_GP3CONF = 0x03,
  REG_INTCONFB2 = 0x04,
  REG_INTCONFB1 = 0x05,
  REG_STATUSB2 = 0x06,
  REG_STATUSB1 = 0x07,
  REG_SSTATUS = 0x08,
  REG_FSTATUS = 0x09,
  REG_CVALB4 = 0x0A,
  REG_CVALB3 = 0x0B,
  REG_CVALB2 = 0x0C,
  REG_CVALB1 = 0x0D,
  REG_CMAXB4 = 0x0E,
  REG_CMAXB3 = 0x0F,
  REG_CMAXB2 = 0x10,
  REG_CMAXB1 = 0x11,
  REG_CMINB4 = 0x12,
  REG_CMINB3 = 0x13,
  REG_CMINB2 = 0x14,
  REG_CMINB1 = 0x15,
  REG_ISTEPB4 = 0x16,
  REG_ISTEPB3 = 0x17,
  REG_ISTEPB2 = 0x18,
  REG_ISTEPB1 = 0x19,
  REG_GP1REG = 0x1A,
  REG_GP2REG = 0x1B,
  REG_GP3REG = 0x1C,
  REG_DPPERIOD = 0x1D,
  REG_FADEGP = 0x1E,
  REG_GAMMAGP1 = 0x1F,
  REG_GAMMAGP2 = 0x20,
  REG_GAMMAGP3 = 0x21,
  REG_IDCODE = 0x70,
  REG_VERSION = 0x71,
  REG_EEPROMS = 0x80,
};

/* NavKey status bits and setting. Use with: INTCONF for set and with ESTATUS for read the bits  */
enum Int_Status
{
  UPR = 0x0001,
  UPP = 0x0002,
  DNR = 0x0004,
  DNP = 0x0008,
  RTR = 0x0010,
  RTP = 0x0020,
  LTR = 0x0040,
  LTP = 0x0080,
  CTRR = 0x0100,
  CTRP = 0x0200,
  CTRDP = 0x0400,
  RINC = 0x0800,
  RDEC = 0x1000,
  RMAX = 0x2000,
  RMIN = 0x4000,
  INT_2 = 0x8000,
};

/* NavKey Int2 bits. Use to read the bits of I2STATUS  */
enum Int2_Status
{
  GP1_POS = 0x01,
  GP1_NEG = 0x02,
  GP2_POS = 0x04,
  GP2_NEG = 0x08,
  GP3_POS = 0x10,
  GP3_NEG = 0x20,
  FADE_INT = 0x40,
};

/* NavKey Fade status bits. Use to read the bits of FSTATUS  */
enum Fade_Status
{
  FADES_GP1 = 0x01,
  FADES_GP2 = 0x02,
  FADES_GP3 = 0x04,
};

/* GPIO Configuration. USe with GP1CONF,GP2CONF,GP3CONF */
enum GP_PARAMETER
{
  GP_PWM = 0x00,
  GP_OUT = 0x01,
  GP_AN = 0x02,
  GP_IN = 0x03,
  GP_PULL_EN = 0x04,
  GP_PULL_DI = 0x00,
  GP_INT_DI = 0x00,
  GP_INT_PE = 0x08,
  GP_INT_NE = 0x10,
  GP_INT_BE = 0x18,
};

enum GAMMA_PARAMETER
{
  GAMMA_1 = 0,
  GAMMA_1_8 = 1,
  GAMMA_2 = 2,
  GAMMA_2_2 = 3,
  GAMMA_2_4 = 4,
  GAMMA_2_6 = 5,
  GAMMA_2_8 = 6,

};

/*********************************** Private functions *************************************/

/** Read 1 byte from the NavKey **/
static uint8_t readNavKeyByte(NavKey *navkey, uint8_t reg)
{
  uint8_t rdata = 0xFF;
  navkey->_tem_data.val = 0;

  i2c_start(&(navkey->i2cBus));
  
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110); // sends i2c address w/ write bit set
  i2c_write(&(navkey->i2cBus), reg);

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add | 0b00000001);
  rdata = i2c_read(&(navkey->i2cBus), 1);
  
  i2c_stop(&(navkey->i2cBus));

  return rdata;
}

/** Read 2 bytes from the NavKey **/
static int16_t readNavKeyInt(NavKey *navkey, uint8_t reg)
{
  navkey->_tem_data.val = 0;

  i2c_start(&(navkey->i2cBus));
  
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110); // sends i2c address w/ write bit set
  i2c_write(&(navkey->i2cBus), reg);

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add | 0b00000001);
  navkey->_tem_data.bval[1] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[0] = i2c_read(&(navkey->i2cBus), 1);

  i2c_stop(&(navkey->i2cBus));

  return ((int16_t)(navkey->_tem_data.val));
}

/** Read 4 bytes from the NavKey **/
static int32_t readNavKeyLong(NavKey *navkey, uint8_t reg)
{
  navkey->_tem_data.val = 0;

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110); // sends i2c address w/ write bit set
  i2c_write(&(navkey->i2cBus), reg);

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add | 0b00000001);
  navkey->_tem_data.bval[3] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[2] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[1] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[0] = i2c_read(&(navkey->i2cBus), 1);

  i2c_stop(&(navkey->i2cBus));

  return ((int32_t)(navkey->_tem_data.val));
}

/** Read 4 bytes from the NavKey **/
static float readNavKeyFloat(NavKey *navkey, uint8_t reg)
{
  navkey->_tem_data.val = 0;

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110); // sends i2c address w/ write bit set
  i2c_write(&(navkey->i2cBus), reg);

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add | 0b00000001);
  navkey->_tem_data.bval[3] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[2] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[1] = i2c_read(&(navkey->i2cBus), 0);
  navkey->_tem_data.bval[0] = i2c_read(&(navkey->i2cBus), 1);

  i2c_stop(&(navkey->i2cBus));

  return ((float)navkey->_tem_data.fval);
}

/** Send to the NavKey 1 byte **/
static void writeNavKey8(NavKey *navkey, uint8_t reg, uint8_t data)
{
  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110);
  i2c_write(&(navkey->i2cBus), reg);
  i2c_write(&(navkey->i2cBus), data);
  i2c_stop(&(navkey->i2cBus));
}

/** Send to the NavKey 4 byte **/
static void writeNavKey32(NavKey *navkey, uint8_t reg, int32_t data)
{
  navkey->_tem_data.val = data;

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110);
  i2c_write(&(navkey->i2cBus), reg);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[3]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[2]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[1]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[0]);
  i2c_stop(&(navkey->i2cBus));
}

/** Send to the NavKey 2 byte **/
static void writeNavKey16(NavKey *navkey, uint8_t reg, uint16_t data)
{
  navkey->_tem_data.val = data;

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110);
  i2c_write(&(navkey->i2cBus), reg);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[1]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[0]);
  i2c_stop(&(navkey->i2cBus));
}

/** Send to the NavKey 4 byte for floating number **/
static void writeNavKeyFloat(NavKey *navkey, uint8_t reg, float data)
{
  navkey->_tem_data.fval = data;

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110);
  i2c_write(&(navkey->i2cBus), reg);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[3]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[2]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[1]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[0]);
  i2c_stop(&(navkey->i2cBus));
}

/** Send to the NavKey 3 byte **/
static void writeNavKey24(NavKey *navkey, uint8_t reg, uint32_t data)
{
  navkey->_tem_data.val = data;

  i2c_start(&(navkey->i2cBus));
  i2c_write(&(navkey->i2cBus), navkey->_add & 0b11111110);
  i2c_write(&(navkey->i2cBus), reg);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[2]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[1]);
  i2c_write(&(navkey->i2cBus), navkey->_tem_data.bval[0]);
  i2c_stop(&(navkey->i2cBus));
}

/*********************************** Public functions *************************************/
/** Used for initialize the NavKey **/
void navkey_begin(NavKey *navkey, int scl, int sda, uint8_t addr, uint8_t conf)
{
  navkey->_add = addr;
  i2c_setup(&(navkey->i2cBus), scl, sda, 10, 1);
  writeNavKey8(navkey, REG_GCONF, (uint8_t)0x80);
  _waitms(100);
  writeNavKey8(navkey, REG_GCONF, conf);
  navkey->_gconf = conf;
}
void navkey_reset(NavKey *navkey)

{
  writeNavKey8(navkey, REG_GCONF, (uint8_t)0x80);
  _waitms(10);
}

/*********************************** Read functions *************************************/

void navkey_update_status(NavKey *navkey)
{
  int16_t reg = readNavKeyInt(navkey, REG_STATUSB2);
  navkey->status.UPR = (reg & UPR)!= 0;
  navkey->status.UPP = (reg & UPP)!= 0;
  navkey->status.DNR = (reg & DNR)!= 0;
  navkey->status.DNP = (reg & DNP)!= 0;
  navkey->status.RTR = (reg & RTR)!= 0;
  navkey->status.RTP = (reg & RTP)!= 0;
  navkey->status.LTR = (reg & LTR)!= 0;
  navkey->status.LTP = (reg & LTP)!= 0;
  navkey->status.CTRR = (reg & CTRR)!= 0;
  navkey->status.CTRP = (reg & CTRP)!= 0;
  navkey->status.CTRDP = (reg & CTRDP);
  navkey->status.RINC = (reg & RINC) != 0;
  navkey->status.RDEC = (reg & RDEC) != 0;
  navkey->status.RMAX = (reg & RMAX) != 0;
  navkey->status.RMIN = (reg & RMIN) != 0;
  navkey->status.raw = reg;
}

/** Return the GP1 Configuration**/
uint8_t navkey_read_gp1_conf(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_GP1CONF));
}

/** Return the GP1 Configuration**/
uint8_t navkey_read_gp2_conf(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_GP2CONF));
}

/** Return the GP1 Configuration**/
uint8_t navkey_read_gp3_conf(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_GP3CONF));
}

/** Return the INT pin configuration**/
uint16_t navkey_read_interrupt_config(NavKey *navkey)
{
  return ((uint16_t)readNavKeyInt(navkey, REG_INTCONFB2));
}

/** Return Fade process status  **/
uint8_t navkey_read_fade_status(NavKey *navkey)
{
  return readNavKeyByte(navkey, REG_FSTATUS);
}

/** Return the 32 bit value of the NavKey counter  **/
float navkey_read_counter_float(NavKey *navkey)
{
  return (readNavKeyFloat(navkey, REG_CVALB4));
}

/** Return the 32 bit value of the NavKey counter  **/
int32_t navkey_read_counter_long(NavKey *navkey)
{
  return (readNavKeyLong(navkey, REG_CVALB4));
}

/** Return the 16 bit value of the NavKey counter  **/
int16_t navkey_read_counter_int(NavKey *navkey)
{
  return ((int16_t)readNavKeyInt(navkey, REG_CVALB2));
}

/** Return the 8 bit value of the NavKey counter  **/
int8_t navkey_read_counter_byte(NavKey *navkey)
{
  return ((int8_t)readNavKeyByte(navkey, REG_CVALB1));
}

/** Return the Maximum threshold of the counter **/
int32_t navkey_read_max(NavKey *navkey)
{
  return ((int32_t)readNavKeyLong(navkey, REG_CMAXB4));
}

/** Return the Minimum threshold of the counter **/
int32_t navkey_read_min(NavKey *navkey)
{
  return ((int32_t)readNavKeyLong(navkey, REG_CMINB4));
}

/** Return the Maximum threshold of the counter **/
float navkey_read_max_float(NavKey *navkey)
{
  return (readNavKeyFloat(navkey, REG_CMAXB4));
}

/** Return the Minimum threshold of the counter **/
float navkey_read_min_float(NavKey *navkey)
{
  return (readNavKeyFloat(navkey, REG_CMINB4));
}

/** Return the Steps increment **/
int32_t navkey_read_step(NavKey *navkey)
{
  return (readNavKeyInt(navkey, REG_ISTEPB4));
}

/** Return the Steps increment, in float variable **/
float navkey_read_step_float(NavKey *navkey)
{
  return (readNavKeyFloat(navkey, REG_ISTEPB4));
}

/** Read GP1 register value **/
uint8_t navkey_read_gp1(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_GP1REG));
}

/** Read GP2 register value **/
uint8_t navkey_read_gp2(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_GP2REG));
}

/** Read GP3 register value **/
uint8_t navkey_read_gp3(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_GP3REG));
}

/** Read Double push period register **/
uint8_t navkey_read_double_push_period(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_DPPERIOD));
}

/** Read the fade period of the GP LED**/
uint8_t navkey_read_fade_gp(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_FADEGP));
}

/** Read the EEPROM memory**/
uint8_t navkey_read_eeprom(NavKey *navkey, uint8_t add)
{
  if (add <= 0x7f)
  {
    if ((navkey->_gconf & EEPROM_BANK1) != 0)
    {
      navkey->_gconf = navkey->_gconf & 0xBF;
      writeNavKey8(navkey, REG_GCONF, navkey->_gconf);
    }
    return (readNavKeyByte(navkey, (REG_EEPROMS + add)));
  }
  else
  {
    if ((navkey->_gconf & EEPROM_BANK1) == 0)
    {
      navkey->_gconf = navkey->_gconf | 0x40;
      writeNavKey8(navkey, REG_GCONF, navkey->_gconf);
    }
    return (readNavKeyByte(navkey, add));
  }
}

/** Read the ID code **/
uint8_t navkey_read_id_code(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_IDCODE));
}

/** Read the Version code **/
uint8_t navkey_read_version(NavKey *navkey)
{
  return (readNavKeyByte(navkey, REG_VERSION));
}

/*********************************** Write functions *************************************/
/** Write the GP1 configuration**/
void navkey_write_gp1_conf(NavKey *navkey, uint8_t gp1)
{
  writeNavKey8(navkey, REG_GP1CONF, gp1);
}

/** Write the GP2 configuration**/
void navkey_write_gp2_conf(NavKey *navkey, uint8_t gp2)
{
  writeNavKey8(navkey, REG_GP2CONF, gp2);
}

/** Write the GP3 configuration**/
void navkey_write_gp3_conf(NavKey *navkey, uint8_t gp3)
{
  writeNavKey8(navkey, REG_GP3CONF, gp3);
}

/** Write the interrupt configuration **/
void navkey_write_interrupt_config(NavKey *navkey, uint16_t interrupt)
{
  writeNavKey16(navkey, REG_INTCONFB2, interrupt);
}

/** Write the counter value **/
void navkey_write_counter(NavKey *navkey, int value)
{
  writeNavKey32(navkey, REG_CVALB4, value);
}

/** Write the maximum threshold value **/
void navkey_write_max(NavKey *navkey, int32_t max)
{
  writeNavKey32(navkey, REG_CMAXB4, max);
}

/** Write the minimum threshold value **/
void navkey_write_min(NavKey *navkey, int32_t min)
{
  writeNavKey32(navkey, REG_CMINB4, min);
}

/** Write the Step increment value **/
void navkey_write_step(NavKey *navkey, int32_t step)
{
  writeNavKey32(navkey, REG_ISTEPB4, step);
}

/** Write GP1 register, used when GP1 is set to output or PWM **/
void navkey_write_gp1(NavKey *navkey, uint8_t gp1)
{
  writeNavKey8(navkey, REG_GP1REG, gp1);
}

/** Write GP2 register, used when GP2 is set to output or PWM **/
void navkey_write_gp2(NavKey *navkey, uint8_t gp2)
{
  writeNavKey8(navkey, REG_GP2REG, gp2);
}

/** Write GP3 register, used when GP3 is set to output or PWM **/
void navkey_write_gp3(NavKey *navkey, uint8_t gp3)
{
  writeNavKey8(navkey, REG_GP3REG, gp3);
}

/** Write Anti-bouncing period register **/
void navkey_write_double_push_period(NavKey *navkey, uint8_t dperiod)
{
  writeNavKey8(navkey, REG_DPPERIOD, dperiod);
}

/** Write Fade timing in ms **/
void navkey_write_fade_gp(NavKey *navkey, uint8_t fade)
{
  writeNavKey8(navkey, REG_FADEGP, fade);
}

/** Write the Gamma value on GP1 **/
void navkey_write_gamma_gp1(NavKey *navkey, uint8_t gamma)
{
  writeNavKey8(navkey, REG_GAMMAGP1, gamma);
}

/** Write the Gamma value on GP2 **/
void navkey_write_gamma_gp2(NavKey *navkey, uint8_t gamma)
{
  writeNavKey8(navkey, REG_GAMMAGP2, gamma);
}

/** Write the Gamma value on GP1 **/
void navkey_write_gamma_gp3(NavKey *navkey, uint8_t gamma)
{
  writeNavKey8(navkey, REG_GAMMAGP3, gamma);
}

/** Write the EEPROM memory**/
void navkey_writeEEPROM(NavKey *navkey, uint8_t add, uint8_t data)
{
  if (add <= 0x7f)
  {
    if ((navkey->_gconf & EEPROM_BANK1) != 0)
    {
      navkey->_gconf = navkey->_gconf & 0xBF;
      writeNavKey8(navkey, REG_GCONF, navkey->_gconf);
    }
    writeNavKey8(navkey, (REG_EEPROMS + add), data);
  }
  else
  {
    if ((navkey->_gconf & EEPROM_BANK1) == 0)
    {
      navkey->_gconf = navkey->_gconf | 0x40;
      writeNavKey8(navkey, REG_GCONF, navkey->_gconf);
    }
    writeNavKey8(navkey, add, data);
  }
}
