//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "app_control.h"
#include "IO_Debug.h"
#include "app_gauge.h"
#include "app_monitor.h"
#include "app_messageSlave.h"
#include "app_testManagement.h"

#include "dev_nvram.h"
#include "dev_cogManager.h"
#include "dev_forceGauge.h"
#include "dev_servo.h"
#include "watchdog.h"

#include "HAL_GPIO.h"
#include "HAL_lock.h"
#include <string.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/* The force, as a percentage of the load cell's rated capacity
 * (loadCellCapacity), past which the machine faults. A cell is specified to
 * survive a safe overload of about 150% of capacity and the drive can push
 * well past that (a NEMA17 on the belt reaches about 65 N against a 2 kg
 * cell's 30 N), so the machine stops driving at 120%: clear of a test that
 * legitimately runs the cell to its full scale, and with margin left for the
 * distance the carriage takes to stop. */
#define APP_CONTROL_OVERLOAD_PERCENT 120

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_CONTROL_LOCK_REQ() HAL_lock_try(app_control_data.lock)
#define APP_CONTROL_LOCK_REQ_BLOCK()        \
    while (APP_CONTROL_LOCK_REQ() == false) \
    {                                       \
    }
#define APP_CONTROL_LOCK_REL() (void)HAL_lock_release(app_control_data.lock)

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    bool triggerMotionEnabled;
    bool triggerMotionDisabled;
} app_control_request_S;

typedef struct
{
    bool motionEnabled;
    bool limitSpeed;
} app_control_output_S;

typedef struct
{
    int32_t maxMachineTension;
    /* mN: |machine force| past this is FORCE_OVERLOAD. Zero when the profile
     * gives no capacity to judge against, which switches the check off. */
    int32_t overloadForce;
} app_control_nvram_S;

typedef struct
{
    app_control_request_S request;

    bool fault[APP_CONTROL_FAULT_COUNT];
    bool restriction[APP_CONTROL_RESTRICTION_COUNT];
    app_control_output_S out;

    bool motionEnabled;
    bool testRunning;
    /* Sticky, for the faults that latch (app_control.h): one seen while motion
     * is enabled stops the machine and stays reported until the operator
     * disables motion. See processFaults for why they cannot self-clear. */
    bool latched[APP_CONTROL_FAULT_COUNT];
    app_control_fault_E faultedReason;
    app_control_restriction_E restrictedReason;

    app_control_state_E state;
    app_control_nvram_S nvram;


    int32_t lock;
} app_control_data_S;
/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static app_control_data_S app_control_data;

/* The order in which simultaneous faults are reported: the first one in this
 * list that is active is the reason given. Causes come before their
 * consequences, so the reason names where to look.
 *
 * It is not the enum's order, which is the wire's and cannot move. The
 * emergency-stop inputs are why: pressing the emergency stop, or tripping an
 * end-of-travel emergency switch, opens the relay chain, and the chain's lost
 * power (ESD_POWER) is the consequence every one of them shares. ESD_POWER
 * comes first in the enum, so reported in enum order it hid which input did
 * it. Here the three inputs come first and ESD_POWER is what is left when
 * none of them explains the lost power.
 *
 * An overloaded cell comes before the stall it may also cause, and after the
 * gauge's own link: a gauge that has stopped answering has no reading to be
 * overloaded by. */
static const app_control_fault_E app_control_faultPriority[] = {
    APP_CONTROL_FAULT_COG,
    APP_CONTROL_FAULT_WATCHDOG,
    APP_CONTROL_FAULT_ESD_SWITCH,
    APP_CONTROL_FAULT_ESD_UPPER,
    APP_CONTROL_FAULT_ESD_LOWER,
    APP_CONTROL_FAULT_ESD_POWER,
    APP_CONTROL_FAULT_SERVO_COMMUNICATION,
    APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION,
    APP_CONTROL_FAULT_FORCE_OVERLOAD,
    APP_CONTROL_FAULT_SERVO_STALL,
};
#define APP_CONTROL_FAULT_PRIORITY_COUNT (sizeof(app_control_faultPriority) / sizeof(app_control_faultPriority[0]))
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

static void app_control_private_processRequests(void);
static app_control_fault_E app_control_private_processFaults(void);
static app_control_restriction_E app_control_private_processRestrictions(void);
static app_control_state_E app_control_private_getDesiredState(void);
static bool app_control_private_latching(app_control_fault_E fault, bool live);

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static void app_control_private_processRequests(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    if (app_control_data.request.triggerMotionEnabled)
    {
        DEBUG_INFO("%s", "CONTROL: motion enable requested\n");
        app_control_data.motionEnabled = true;
        app_control_data.request.triggerMotionEnabled = false;
    }

    if (app_control_data.request.triggerMotionDisabled)
    {
        /* Who turned motion off is the first question whenever a test ends
         * with "motion disabled", and nothing recorded it until now. */
        DEBUG_INFO("%s", "CONTROL: motion DISABLE requested\n");
        app_control_data.motionEnabled = false;
        app_control_data.request.triggerMotionDisabled = false;
        /* The operator's acknowledgement of a latched fault. Nothing else
         * clears one -- a jam has to be cleared by hand, an emergency stop
         * released and its circuit reset -- and asking for motion off is the
         * one action that says someone has looked at the machine. A cause that
         * is still present keeps its fault, live, and motion stays refused
         * until it has gone. */
        memset(app_control_data.latched, 0, sizeof(app_control_data.latched));
    }
    APP_CONTROL_LOCK_REL();
}

/* One of the faults that latch (app_control.h). `live` is its cause, read this
 * tick. Returns whether the fault stands: its cause is present, or it was
 * while motion was enabled and nobody has acknowledged it since.
 *
 * Latching only while motion is ENABLED is what makes the acknowledgement take
 * effect on the first press: processRequests has already cleared both the
 * latch and motionEnabled by the time this runs, so a cause still present on
 * that tick -- the residue of the one that stopped the machine -- does not
 * re-arm it. */
static bool app_control_private_latching(app_control_fault_E fault, bool live)
{
    if (app_control_data.motionEnabled && live)
    {
        app_control_data.latched[fault] = true;
    }
    return live || app_control_data.latched[fault];
}


static app_control_fault_E app_control_private_processFaults(void)
{
    app_control_data.fault[APP_CONTROL_FAULT_COG] = dev_cogManager_isAllRunning() == false;
    app_control_data.fault[APP_CONTROL_FAULT_WATCHDOG] = watchdog_isAllAlive() == false;
    /* The emergency-stop inputs LATCH (app_control_private_latching). The
     * request for motion outlives a fault, so one recomputed from the live
     * input alone would let the machine come back by itself the moment the
     * emergency stop was released or its circuit reset -- and a press shorter
     * than the host's state poll would stop a test and leave no reason behind. */
    app_control_data.fault[APP_CONTROL_FAULT_ESD_POWER] =
        app_control_private_latching(APP_CONTROL_FAULT_ESD_POWER, HAL_GPIO_getActive(HAL_GPIO_ESD_POWER));
    app_control_data.fault[APP_CONTROL_FAULT_ESD_SWITCH] =
        app_control_private_latching(APP_CONTROL_FAULT_ESD_SWITCH, HAL_GPIO_getActive(HAL_GPIO_ESD_SWITCH));
    app_control_data.fault[APP_CONTROL_FAULT_ESD_UPPER] =
        app_control_private_latching(APP_CONTROL_FAULT_ESD_UPPER, HAL_GPIO_getActive(HAL_GPIO_ESD_UPPER));
    app_control_data.fault[APP_CONTROL_FAULT_ESD_LOWER] =
        app_control_private_latching(APP_CONTROL_FAULT_ESD_LOWER, HAL_GPIO_getActive(HAL_GPIO_ESD_LOWER));
    /* The MOTOR cog runs dev_servo. Asked directly rather than through a local
     * `actuator_*` macro: app_motion.c already owns that abstraction, and a
     * second copy here bought one call site an alias that hid what it reads.
     *
     * What it reads is LIVENESS, not communication, whatever the fault is
     * called: `out.ready` means "the control loop has ticked" (dev_servo.c --
     * false until the cog has run, set true each tick, and still true while the
     * servo is disabled, because the loop is what keeps ticking). No UART, no
     * request, no reply that can land a cycle late. One false reading means the
     * loop has stopped, so this is instantaneous like the watchdog above it. */
    const bool motorLoopAlive = dev_servo_isReady(DEV_SERVO_CHANNEL_MAIN);
    app_control_data.fault[APP_CONTROL_FAULT_SERVO_COMMUNICATION] = (motorLoopAlive == false);
    /* No window here either. dev_forceGauge now reports ready as ALIVE rather
     * than "fresh sample this tick": a missed reply keeps it ready while the
     * driver re-reads, and it goes un-ready only once the driver has spent its
     * retry budget and torn the ADC down. The debounce this used to carry was
     * APP guessing at a duration the driver already knew -- 20 ms for the read
     * plus four 10 ms retries -- so the knowledge now lives where it belongs
     * and the fault is event-driven instead of timed. */
    app_control_data.fault[APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION] =
        (dev_forceGauge_isReady(DEV_FORCEGAUGE_CHANNEL_MAIN) == false);

    /* A stall is the encoder not following where the driver is driving it
     * -- a following error past the hard ceiling, or held in the soft band
     * too long, or too little encoder travel for the step pulses sent (see
     * dev_servo.h). It is a mechanical fault, so unlike the
     * liveness faults above it LATCHES until the operator acknowledges it by
     * disabling motion.
     *
     * It has to. Disabling motion is exactly what clears dev_servo's stall
     * flag -- the driver stops commanding velocity and drops its verdict -- so a
     * fault recomputed from the live flag would disable the machine, watch its
     * own cause disappear, clear, re-enable and drive into the same jam moments
     * later, indefinitely.
     *
     * A stall reported while motion is off is not a fault at all -- nothing is
     * being driven -- so only the latch is reported, never the live flag. */
    (void)app_control_private_latching(APP_CONTROL_FAULT_SERVO_STALL,
                                       dev_servo_isStalled(DEV_SERVO_CHANNEL_MAIN));
    app_control_data.fault[APP_CONTROL_FAULT_SERVO_STALL] =
        app_control_data.latched[APP_CONTROL_FAULT_SERVO_STALL];

    /* Overload: the load cell past its capacity by the overload margin, in
     * either direction, in any state -- a jog can crush a cell as surely as a
     * test can. It is judged on the machine's own force, since the sample
     * frame's zero is wherever the operator last set it. The check is off
     * while the profile gives no capacity (overloadForce 0).
     *
     * It latches for the reason the stall does: stopping the drive lets the
     * load relax, so the reading that raised the fault is gone a moment after
     * the fault has acted. */
    const int32_t machineForce = app_gauge_getForce(APP_GAUGE_COORD_MACHINE);
    const bool overloaded = (app_control_data.nvram.overloadForce > 0) &&
                            ((machineForce > app_control_data.nvram.overloadForce) ||
                             (machineForce < -app_control_data.nvram.overloadForce));
    app_control_data.fault[APP_CONTROL_FAULT_FORCE_OVERLOAD] =
        app_control_private_latching(APP_CONTROL_FAULT_FORCE_OVERLOAD, overloaded);

    /* The first active fault in the reporting order is the reason. */
    app_control_fault_E fault = APP_CONTROL_FAULT_NONE;
    for (uint32_t index = 0U; index < APP_CONTROL_FAULT_PRIORITY_COUNT; index++)
    {
        if (app_control_data.fault[app_control_faultPriority[index]])
        {
            fault = app_control_faultPriority[index];
            break;
        }
    }

    return fault;
}

static app_control_restriction_E app_control_private_processRestrictions(void)
{
    if (app_control_data.testRunning)
    {
        /* Sample limits live on app_monitor (maxForce mN, maxDisplacement mm).
         * Mirror its exceeded flags into control restrictions so the state
         * machine can drop into RESTRICTED and limit speed. */
        app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION] =
            app_monitor_isForceExceeded();
        app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH] =
            app_monitor_isDisplacementExceeded();
    }
    else
    {
        // Do not check sample conditions unless test is running
        app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH] = false;
        app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION] = false;
    }

    app_control_data.restriction[APP_CONTROL_RESTRICTION_MACHINE_TENSION] =
        (app_gauge_getForce(APP_GAUGE_COORD_MACHINE) > app_control_data.nvram.maxMachineTension);
    app_control_data.restriction[APP_CONTROL_RESTRICTION_UPPER_ENDSTOP] = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_UPPER);
    app_control_data.restriction[APP_CONTROL_RESTRICTION_LOWER_ENDSTOP] = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_LOWER);
    app_control_data.restriction[APP_CONTROL_RESTRICTION_DOOR] = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_DOOR);

    // Select the first condition as the reason
    app_control_restriction_E condition = APP_CONTROL_RESTRICTION_NONE;
    for (app_control_restriction_E index = (app_control_restriction_E)0U; index < APP_CONTROL_RESTRICTION_COUNT; index++)
    {
        if (app_control_data.restriction[index])
        {
            condition = index;
            break;
        }
    }

    return condition;
}

static app_control_state_E app_control_private_getDesiredState(void)
{
    app_control_state_E desiredState;
    if (app_control_data.faultedReason != APP_CONTROL_FAULT_NONE)
    {
        desiredState = APP_CONTROL_STATE_DISABLED;
    }
    else if (app_control_data.motionEnabled == false)
    {
        desiredState = APP_CONTROL_STATE_DISABLED;
    }
    else if (app_control_data.restrictedReason != APP_CONTROL_RESTRICTION_NONE)
    {
        desiredState = APP_CONTROL_STATE_RESTRICTED;
    }
    else if (app_control_data.testRunning == false)
    {
        desiredState = APP_CONTROL_STATE_MANUAL;
    }
    else
    {
        desiredState = APP_CONTROL_STATE_TEST;
    }
    return desiredState;
}

static void app_control_private_setOutput(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    switch (app_control_data.state)
    {
    case APP_CONTROL_STATE_DISABLED:
        app_control_data.out.motionEnabled = false;
        app_control_data.out.limitSpeed = false;
        break;
    case APP_CONTROL_STATE_RESTRICTED:
        app_control_data.out.motionEnabled = true;
        app_control_data.out.limitSpeed = true;
        break;
    case APP_CONTROL_STATE_MANUAL:
        app_control_data.out.motionEnabled = true;
        app_control_data.out.limitSpeed = false;
        break;
    case APP_CONTROL_STATE_TEST:
        app_control_data.out.motionEnabled = true;
        app_control_data.out.limitSpeed = false;
        break;
    case APP_CONTROL_STATE_COUNT:
    default:
        break;
    }
    APP_CONTROL_LOCK_REL();
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void app_control_init(int lock)
{
    app_control_data.lock = lock;
    app_control_data.state = APP_CONTROL_STATE_DISABLED;
    MachineProfile machineProfile;
    (void)dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));
    app_control_data.nvram.maxMachineTension = machineProfile.maxForceTensile;
    /* int64 intermediate: a 20 kN cell is 20,000,000 mN, and that times 120
     * is past int32. One expression and no ternary around it, which is the
     * 64-bit form flexcc compiles. */
    app_control_data.nvram.overloadForce = 0;
    if (machineProfile.loadCellCapacity > 0)
    {
        app_control_data.nvram.overloadForce =
            (int32_t)(((int64_t)machineProfile.loadCellCapacity * APP_CONTROL_OVERLOAD_PERCENT) / 100);
    }
}

void app_control_run(void)
{
    app_control_private_processRequests();
    app_control_data.testRunning = app_testManagement_isRunning();
    const app_control_fault_E previousFault = app_control_data.faultedReason;
    app_control_data.faultedReason = app_control_private_processFaults();
    if (app_control_data.faultedReason != previousFault)
    {
        /* A fault is what silently disables motion, and a transient one (a
         * gauge or servo that misses a reply for one cycle) aborts a running
         * test with "motion disabled" and then clears before anyone polling
         * the state can see it. Record the edge. */
        DEBUG_INFO("CONTROL: fault %d -> %d\n", (int)previousFault, (int)app_control_data.faultedReason);
    }
    app_control_data.restrictedReason = app_control_private_processRestrictions();
    app_control_data.state = app_control_private_getDesiredState();
    app_control_private_setOutput();
}

bool app_control_motionEnabled(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    const bool motionEnabled = app_control_data.out.motionEnabled;
    APP_CONTROL_LOCK_REL();
    return motionEnabled;
}

// Logging only
app_control_fault_E app_control_getFault(void)
{
    // This is not thread safe, might be fine cause setting is atomic
    APP_CONTROL_LOCK_REQ_BLOCK();
    const app_control_fault_E fault = app_control_data.faultedReason;
    APP_CONTROL_LOCK_REL();
    return fault;
}

app_control_restriction_E app_control_getRestriction(void)
{
    // This is not thread safe, might be fine cause setting is atomic
    APP_CONTROL_LOCK_REQ_BLOCK();
    const app_control_restriction_E condition = app_control_data.restrictedReason;
    APP_CONTROL_LOCK_REL();
    return condition;
}

// End of logging

bool app_control_speedLimited(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    const bool limitSpeed = app_control_data.out.limitSpeed;
    APP_CONTROL_LOCK_REL();
    return limitSpeed;
}

bool app_control_triggerMotionEnabled(void)
{
    bool motionReady = false;
    APP_CONTROL_LOCK_REQ_BLOCK();
    if (app_control_data.faultedReason == APP_CONTROL_FAULT_NONE)
    {
        app_control_data.request.triggerMotionEnabled = true;
        motionReady = true;
    }
    APP_CONTROL_LOCK_REL();
    return motionReady;
}

bool app_control_triggerMotionDisabled(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    app_control_data.request.triggerMotionDisabled = true;
    APP_CONTROL_LOCK_REL();
    return true;
}

/**********************************************************************
 * End of File
 **********************************************************************/
