//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_serial.h"

#include "smartpins.h"
#include "propeller2.h"
#include "IO_Debug.h"
#include <stdlib.h>
/**********************************************************************
 * Constants
 **********************************************************************/
/* Consecutive empty polls before a burst receive returns. Bytes no longer
 * depend on this (the RX interrupt below catches every one); it only paces the
 * SERIAL cog's loop, and with it how often that cog kicks the watchdog. */
#define HAL_SERIAL_RX_IDLE_SPINS (1024U)

/* The channel whose RX is taken by interrupt: the 2 Mbaud protocol link, the
 * only one fast enough to need it.
 *
 * An async-RX smart pin holds ONE byte and the next byte overwrites it; at
 * 2 Mbaud that is 800 clocks (5 us at 160 MHz). The SERIAL cog cannot poll that
 * often: each byte it transmits blocks it for a byte time, and the cogManager
 * wrapper between two receive calls (watchdog kick on the shared critical lock,
 * _getus, the call chain) leaves the pin unread for 1,600-4,500 clocks every
 * time (measured on a P2-EVAL). A request whose bytes landed in such a gap lost
 * one and was never answered. */
#define HAL_SERIAL_RX_ISR_CHANNEL (HAL_SERIAL_CHANNEL_MAIN)

/* Hub ring the ISR fills. Holds over 5 ms of back-to-back bytes at 2 Mbaud. */
#define HAL_SERIAL_RX_RING_SIZE (1024U)

/* The ISR's cog registers and code location: FlexC leaves cog $1E0-$1EF and
 * LUT $200-$20F to application PASM (FlexSpin general.md, "Register Usage"). */
#define HAL_SERIAL_ISR_PIN (0x1e0)   /* RX smart pin */
#define HAL_SERIAL_ISR_BUF (0x1e1)   /* hub address of ring[0] */
#define HAL_SERIAL_ISR_HEAD (0x1e2)  /* write index, the ISR's own copy */
#define HAL_SERIAL_ISR_LAST (0x1e3)  /* RING_SIZE - 1, the INCMOD bound */
#define HAL_SERIAL_ISR_BYTE (0x1e4)  /* scratch: the byte */
#define HAL_SERIAL_ISR_NEXT (0x1e5)  /* scratch: head + 1 */
#define HAL_SERIAL_ISR_TMP (0x1e6)   /* scratch */
#define HAL_SERIAL_ISR_TAILP (0x1e7) /* hub address of tail */
#define HAL_SERIAL_ISR_OVRP (0x1e8)  /* hub address of the overrun flag */
#define HAL_SERIAL_ISR_HEADP (0x1e9) /* hub address of the published head */
#define HAL_SERIAL_ISR_LUT_LONGS (16U)
/* SETSE1 %110_PPPPPP: event while the pin's IN is high (a byte is waiting).
 * The same level event the boot ROM's own serial receiver uses. */
#define HAL_SERIAL_ISR_SE1_IN_HIGH (0x6U << 6)
#define HAL_SERIAL_ISR_INT1_SE1 (4)

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
/* Single producer (the ISR) and single consumer (the code of the cog that
 * armed it), so no lock: the ISR writes the byte, then publishes head; the
 * consumer reads the byte, then publishes tail. One cog, so program order. */
typedef struct
{
    volatile uint32_t head;
    volatile uint32_t tail;
    volatile uint32_t overrun; /* set by the ISR when the ring was full and a byte dropped */
    volatile uint8_t ring[HAL_SERIAL_RX_RING_SIZE];
    bool armed;
} HAL_serial_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
// channel config table lives in HAL/Config/HAL_serial_config.c (data-only, all targets)
static HAL_serial_data_S HAL_serial_data;

/* INT1 service routine, copied into LUT $200 by
 * HAL_serial_private_armRxInterrupt and run from there. Fires while the RX pin
 * holds a byte; moves it into the hub ring. The event is a level, but silicon
 * ignores it while the ISR runs and RDPIN has dropped IN by the RETI1, so it
 * does not re-enter (SIL/p2core/hwtest/events.c). Self-contained, so it is
 * safe beside compiled code: it touches only its own registers and LUT longs,
 * never PA/PB, PTRx, the hardware stack, the FIFO or the CORDIC. C and Z are
 * saved in IRET1 on entry and restored by RETI1 (CALLD INB, IRET1 WCZ). `fit`
 * makes outgrowing the 16 free LUT longs a build error. */
__asm {
        org     0x200
HAL_serial_private_rxIsr
        testp   HAL_SERIAL_ISR_PIN                      wc  // defensive: silicon only enters with a byte waiting
 if_nc  reti1
        rdpin   HAL_SERIAL_ISR_BYTE, HAL_SERIAL_ISR_PIN     // read and acknowledge: IN drops
        shr     HAL_SERIAL_ISR_BYTE, #24                    // the byte arrives in bits 31:24
        mov     HAL_SERIAL_ISR_NEXT, HAL_SERIAL_ISR_HEAD
        incmod  HAL_SERIAL_ISR_NEXT, HAL_SERIAL_ISR_LAST
        rdlong  HAL_SERIAL_ISR_TMP, HAL_SERIAL_ISR_TAILP
        cmp     HAL_SERIAL_ISR_NEXT, HAL_SERIAL_ISR_TMP     wz  // full: drop the byte, say so
 if_z   wrlong  #1, HAL_SERIAL_ISR_OVRP
 if_z   reti1
        mov     HAL_SERIAL_ISR_TMP, HAL_SERIAL_ISR_BUF
        add     HAL_SERIAL_ISR_TMP, HAL_SERIAL_ISR_HEAD
        wrbyte  HAL_SERIAL_ISR_BYTE, HAL_SERIAL_ISR_TMP
        mov     HAL_SERIAL_ISR_HEAD, HAL_SERIAL_ISR_NEXT
        wrlong  HAL_SERIAL_ISR_HEAD, HAL_SERIAL_ISR_HEADP   // publish only after the byte is in the ring
        reti1
        fit     0x210
        orgh
}
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/* Take the channel's RX by interrupt on the CALLING cog: interrupts are per cog,
 * so this must run on the cog that drains the channel, never at init (which
 * runs on the main cog). From here on every byte of the channel goes through
 * the ring, so only this cog may read it. */
static void HAL_serial_private_armRxInterrupt(HAL_serial_channel_E channel)
{
    const uint32_t pin = (uint32_t)HAL_serial_channelConfig[channel].rx;
    const uint32_t *const code = (const uint32_t *)&HAL_serial_private_rxIsr;
    const uint32_t buf = (uint32_t)&HAL_serial_data.ring[0];
    const uint32_t last = HAL_SERIAL_RX_RING_SIZE - 1U;
    const uint32_t tailp = (uint32_t)&HAL_serial_data.tail;
    const uint32_t ovrp = (uint32_t)&HAL_serial_data.overrun;
    const uint32_t headp = (uint32_t)&HAL_serial_data.head;
    const uint32_t se1 = HAL_SERIAL_ISR_SE1_IN_HIGH | pin;

    HAL_serial_data.head = 0U;
    HAL_serial_data.tail = 0U;
    HAL_serial_data.overrun = 0U;
    for (uint32_t i = 0U; i < HAL_SERIAL_ISR_LUT_LONGS; i++)
    {
        const uint32_t insn = code[i];
        __asm volatile {
            wrlut   insn, i
        }
    }
    __asm volatile {
        mov     HAL_SERIAL_ISR_PIN, pin
        mov     HAL_SERIAL_ISR_BUF, buf
        mov     HAL_SERIAL_ISR_HEAD, #0
        mov     HAL_SERIAL_ISR_LAST, last
        mov     HAL_SERIAL_ISR_TAILP, tailp
        mov     HAL_SERIAL_ISR_OVRP, ovrp
        mov     HAL_SERIAL_ISR_HEADP, headp
        mov     ijmp1, ##0x200
        setse1  se1
        setint1 #HAL_SERIAL_ISR_INT1_SE1
    }
    HAL_serial_data.armed = true;
}

static inline bool HAL_serial_private_popRing(uint8_t *const byte)
{
    const uint32_t tail = HAL_serial_data.tail;
    if (HAL_serial_data.head == tail)
    {
        return false;
    }
    *byte = HAL_serial_data.ring[tail];
    HAL_serial_data.tail = (tail == (HAL_SERIAL_RX_RING_SIZE - 1U)) ? 0U : (tail + 1U);
    return true;
}

void HAL_serial_private_TXFlush(HAL_serial_channel_E channel)
{
    // flush the transmit buffer
    switch (HAL_serial_channelConfig[channel].type)
    {
        case HAL_SERIAL_TYPE_HARDWARE:
            while (_pinr(HAL_serial_channelConfig[channel].tx) == 0)
                ;
            break;
        case HAL_SERIAL_TYPE_BUILTIN:
        default:
            break;
    }
}

static inline bool HAL_serial_private_readByte(HAL_serial_channel_E channel, uint8_t *const byte)
{
    int32_t tmp = -1;
    if ((channel == HAL_SERIAL_RX_ISR_CHANNEL) && HAL_serial_data.armed)
    {
        /* The ISR owns the pin now; reading it here would steal a byte. */
        return HAL_serial_private_popRing(byte);
    }
    switch (HAL_serial_channelConfig[channel].type)
    {
        case HAL_SERIAL_TYPE_HARDWARE:
            if (_pinr(HAL_serial_channelConfig[channel].rx) != 0)
            {
                *byte = (_rdpin(HAL_serial_channelConfig[channel].rx) >> 24);
                return true;
            }
            else
            {
                return false;
            }
        case HAL_SERIAL_TYPE_BUILTIN:
            tmp = _rxpoll();
            if (tmp != -1)
            {
                *byte = tmp;
                return true;
            }
            else
            {
                return false;
            }
        default:
            return 0U;
    }
}

static inline void HAL_serial_private_writeByte(HAL_serial_channel_E channel, uint8_t byte)
{
    if (HAL_serial_channelConfig[channel].LSB)
    {
        // P2 sends MSB first, if LSB is true, we need to swap the bits
        byte = (__builtin_bitreverse32(byte) >> 24) & 0xFF;
    }
    switch (HAL_serial_channelConfig[channel].type)
    {
        case HAL_SERIAL_TYPE_HARDWARE:
            _wypin(HAL_serial_channelConfig[channel].tx, byte);
            break;
        case HAL_SERIAL_TYPE_BUILTIN:
            _txraw(byte);
            break;
        default:
            break;
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_serial_start(HAL_serial_channel_E channel)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        switch (HAL_serial_channelConfig[channel].type)
        {
            case HAL_SERIAL_TYPE_HARDWARE:
            {
                // calculate delay between bits
                const int32_t bitPeriod = (_clockfreq() / HAL_serial_channelConfig[channel].baud);

                // calculate smartpin mode for 8 bits per character
                const int32_t bitMode = 7 + (bitPeriod << 16);

                // set up the transmit pin
                _pinstart(HAL_serial_channelConfig[channel].tx, P_OE | P_ASYNC_TX, bitMode, 0);

                // set up the receive pin
                _pinstart(HAL_serial_channelConfig[channel].rx, P_ASYNC_RX, bitMode, 0);
            }
            break;
        case HAL_SERIAL_TYPE_BUILTIN:
            _setbaud(HAL_serial_channelConfig[channel].baud);
        default:
            break;
        }
    }
}

void HAL_serial_stop(HAL_serial_channel_E channel)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        // turn off the smartpin
        switch(HAL_serial_channelConfig[channel].type)
        {
            case HAL_SERIAL_TYPE_HARDWARE:
                _pinclear(HAL_serial_channelConfig[channel].rx);
                _pinclear(HAL_serial_channelConfig[channel].tx);
                break;
            case HAL_SERIAL_TYPE_BUILTIN:
            case HAL_SERIAL_TYPE_COUNT:
                // do not disable the serial port
                break;
        }
    }
}

void HAL_serial_transmitData(HAL_serial_channel_E channel, const uint8_t *const data, const uint32_t len)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        for (uint32_t i = 0; i < len; i++)
        {
            HAL_serial_private_writeByte(channel, data[i]);
            // wait for the byte to be sent
            HAL_serial_private_TXFlush(channel);
        }
    }
}

bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E channel, uint8_t *const data, uint32_t len, uint32_t timeout_us)
{
    if ((channel < HAL_SERIAL_CHANNEL_COUNT) && (data != NULL))
    {
        // wait for the byte to be received
        const int32_t startTime = _getus();
        for (uint32_t i = 0; i < len; i++)
        {
            uint8_t byte = 0U;
            while (HAL_serial_recieveByte(channel, &byte) == false)
            {
                if ((_getus() - startTime) > timeout_us)
                {
                    return false;
                }
            }
            data[i] = byte;
        }
        return true;
    }
    return false;
}

bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const byte)
{
    bool result = false;
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        result = HAL_serial_private_readByte(channel, byte);
    }
    return result;
}

uint32_t HAL_serial_recieveBytes(HAL_serial_channel_E channel, uint8_t *const buf, uint32_t maxBytes)
{
    uint32_t count = 0U;
    if ((channel < HAL_SERIAL_CHANNEL_COUNT) && (buf != NULL))
    {
        if (channel == HAL_SERIAL_RX_ISR_CHANNEL)
        {
            if (HAL_serial_data.armed == false)
            {
                HAL_serial_private_armRxInterrupt(channel);
            }
            if (HAL_serial_data.overrun != 0U)
            {
                HAL_serial_data.overrun = 0U;
                DEBUG_ERROR("RX ring full on serial channel %d: bytes dropped\n", channel);
            }
        }
        uint32_t idle = 0U;
        while (count < maxBytes)
        {
            /* HAL_serial_private_readByte is static inline, so this loop is a
             * ring (or smartpin) poll + a store — no per-byte call overhead. */
            if (HAL_serial_private_readByte(channel, &buf[count]))
            {
                count++;
                idle = 0U;
            }
            else
            {
                idle++;
                if (idle >= HAL_SERIAL_RX_IDLE_SPINS)
                {
                    break;
                }
            }
        }
    }
    return count;
}

/**********************************************************************
 * End of File
 **********************************************************************/
