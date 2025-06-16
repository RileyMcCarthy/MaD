//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <string.h>
#include "app_messageSlave.h"
#include "app_monitor.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_notification.h"

#include "dev_forceGauge.h"

#include "IO_protocol.h"
#include "JsonDecoder.h"
#include "dev_nvram.h"
#include "IO_logger.h"
#include "IO_Debug.h"
#include "lib_utility.h"
#include "IO_gcode.h"
/**********************************************************************
 * Constants
 **********************************************************************/

// Firmware version string - this will be set during build
#ifdef FIRMWARE_VERSION
  static const char* APP_MESSAGE_SLAVE_VERSION = FIRMWARE_VERSION;
#else
  static const char* APP_MESSAGE_SLAVE_VERSION = "0.0.0"; // development, no version set
#endif

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_MESSAGESLAVE_LOCK_REQ() _locktry(app_message_slave_data.lock)
#define APP_MESSAGESLAVE_LOCK_REQ_BLOCK()        \
    while (APP_MESSAGESLAVE_LOCK_REQ() == false) \
        ;
#define APP_MESSAGESLAVE_LOCK_REL() _lockrel(app_message_slave_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    APP_MESSAGE_SLAVE_RESPONSE_TYPE_NONE, // invalid message, request should be ignored
    APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK,
    APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK,
    APP_MESSAGE_SLAVE_RESPONSE_TYPE_DATA,
} app_message_slave_responseType_E;

typedef struct
{
    bool triggerTest;
} app_message_slave_output_S;

typedef struct
{
    char dataRX[APP_MESSAGE_SLAVE_RX_BUFFER_SIZE];
    char dataTX[APP_MESSAGE_SLAVE_TX_BUFFER_SIZE];
    MachineProfile machineProfile;
    int lock;

    app_message_slave_output_S stagedOutput;
    app_message_slave_output_S output;
} app_message_slave_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static app_message_slave_data_S app_message_slave_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static app_message_slave_responseType_E app_message_slave_private_handleRead(IO_protocol_readType_E readType)
{
    app_message_slave_responseType_E responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NONE;
    int32_t dataSize = 0;
    switch (readType)
    {
    case IO_PROTOCOL_READ_TYPE_SAMPLE:
    {
        app_monitor_sample_t sample;
        app_monitor_getSample(&sample);
        const int32_t machinePosition = app_motion_getPosition();
        const int32_t machineSetpoint = app_motion_getSetpoint();
        const int32_t machineForce = dev_forceGauge_getForce(DEV_FORCEGAUGE_CHANNEL_MAIN);

        dataSize = snprintf(app_message_slave_data.dataTX, APP_MESSAGE_SLAVE_TX_BUFFER_SIZE,
                 "{\"Machine Force (N)\":%0.3f,\"Machine Position (mm)\":%d,\"Machine Setpoint (mm)\":%d,\"Sample Force (N)\":%0.3f,\"Sample Position (mm)\":%d,\"Index\":%u}",
                 LIB_UTILITY_MN_TO_N(machineForce), machinePosition, LIB_UTILITY_UM_TO_MM(machineSetpoint), LIB_UTILITY_MN_TO_N(sample.force), LIB_UTILITY_UM_TO_MM(sample.position), sample.index);
        responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_DATA;
        break;
    }
    case IO_PROTOCOL_READ_TYPE_STATE:
    {
        const app_control_fault_E faultedReason = app_control_getFault();
        const app_control_restriction_E restrictedReason = app_control_getRestriction();
        const bool testRunning = app_control_testRunning();
        const bool motionEnabled = app_control_motionEnabled();
        dataSize = snprintf(app_message_slave_data.dataTX, APP_MESSAGE_SLAVE_TX_BUFFER_SIZE,
                 "{\"faultedReason\":%d,\"restrictedReason\":%d,\"testRunning\":%d,\"motionEnabled\":%d}",
                 faultedReason, restrictedReason, testRunning, motionEnabled);
        responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_DATA;
        break;
    }
    case IO_PROTOCOL_READ_TYPE_MACHINE_CONFIGURATION:
    {
        // Respond with current nvram machine profile
        dataSize = snprintf(app_message_slave_data.dataTX, APP_MESSAGE_SLAVE_TX_BUFFER_SIZE,
                 "{\"Name\":\"%s\",\
                \"Encoder (step/mm)\":%d,\
                \"Servo (step/mm)\":%d,\
                \"Force Gauge (N/step)\":%d,\
                \"Force Gauge Zero Offset (steps)\":%d,\
                \"Position Max (mm)\":%d,\
                \"Velocity Max (mm/s)\":%d,\
                \"Acceleration Max (mm/s^2)\":%d,\
                \"Tensile Force Max (N)\":%d}",
                 app_message_slave_data.machineProfile.name,
                 app_message_slave_data.machineProfile.encoderStepsPerMM,
                 app_message_slave_data.machineProfile.servoStepsPerMM,
                 app_message_slave_data.machineProfile.forceGaugeNPerStep,
                 app_message_slave_data.machineProfile.forceGaugeZeroOffset,
                 app_message_slave_data.machineProfile.maxPosition,
                 app_message_slave_data.machineProfile.maxVelocity,
                 app_message_slave_data.machineProfile.maxAcceleration,
                 app_message_slave_data.machineProfile.maxForceTensile);
        responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_DATA;
        DEBUG_INFO("%s", "responding with machine profile\n");
    }
    break;
    case IO_PROTOCOL_READ_TYPE_FIRMWARE_VERSION:
    {
        DEBUG_INFO("responding with firmware version: %s\n", APP_MESSAGE_SLAVE_VERSION);
        dataSize = snprintf(app_message_slave_data.dataTX, APP_MESSAGE_SLAVE_TX_BUFFER_SIZE,
                 "{\"version\":\"%s\"}", APP_MESSAGE_SLAVE_VERSION);
        responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_DATA;
    }
    break;
    case IO_PROTOCOL_READ_TYPE_COUNT:
    default:
        break;
    }

    if (dataSize > APP_MESSAGE_SLAVE_TX_BUFFER_SIZE)
    {
        DEBUG_ERROR("data size is too large: %d\n", dataSize);
        responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        app_message_slave_data.dataTX[0] = '\0';
    }
    else if (dataSize < 0)
    {
        DEBUG_ERROR("data size is negative: %d\n", dataSize);
        responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        app_message_slave_data.dataTX[0] = '\0';
    }
    else
    {
        // DEBUG_INFO("data size is valid: %d\n", dataSize);
    }
    app_message_slave_data.dataTX[APP_MESSAGE_SLAVE_TX_BUFFER_SIZE - 1] = '\0';
    return responseType;
}

static app_message_slave_responseType_E app_message_slave_private_handleWrite(IO_protocol_writeType_E writeType, char *data, uint32_t dataSize)
{
    // confirm string is null terminated
    app_message_slave_data.dataRX[dataSize] = '\0';

    app_message_slave_responseType_E responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NONE;
    switch (writeType)
    {
    case IO_PROTOCOL_WRITE_TYPE_MACHINE_CONFIGURATION:
    {
        // Save incomming configuration to NVRAM
        MachineProfile newProfile;
        if (json_to_machine_profile(&newProfile, app_message_slave_data.dataRX))
        {
            dev_nvram_updateChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &newProfile, sizeof(MachineProfile));
            // HACK: should have this notify once it successfully writes to NVRAM, this should really just be on UI side once ACK recieved
            app_notification_send(APP_NOTIFICATION_TYPE_SUCCESS, "Machine profile saved to SD Card, please reboot\n");
            responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            DEBUG_INFO("%s", "saved new machine profile\n");
        }
        else
        {
            DEBUG_WARNING("%s", "failed to parse machine profile\n");
            responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        }
    }
    break;
    case IO_PROTOCOL_WRITE_TYPE_MOTION_ENABLE:
        if (app_message_slave_data.dataRX[0] == '1')
        {
            DEBUG_INFO("%s", "motion enabled\n");
            if (app_control_triggerMotionEnabled())
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            }
            else
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
            }
        }
        else if (app_message_slave_data.dataRX[0] == '0')
        {
            DEBUG_INFO("%s", "motion disabled\n");
            if (app_control_triggerMotionDisabled())
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            }
            else
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
            }
        }
        else
        {
            responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        }
        break;
    case IO_PROTOCOL_WRITE_TYPE_TEST_RUN:
        if (app_message_slave_data.dataRX[0] != '\0')
        {
            // Set the test name before starting the test
            app_monitor_setTestName(app_message_slave_data.dataRX);
            if (app_control_triggerTestStart())
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            }
            else
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
            }
        }
        break;
    case IO_PROTOCOL_WRITE_TYPE_MANUAL_MOVE:
    {
        lib_json_move_S moveJSON;
        if (json_to_move(&moveJSON, app_message_slave_data.dataRX))
        {
            app_motion_move_t move;
            move.x = moveJSON.x * 1000; // mm -> um
            move.f = moveJSON.f * 1000; // mm/s -> um/s
            move.g = moveJSON.g;
            move.p = moveJSON.p;
            if (app_motion_addManualMove(&move))
            {
                DEBUG_INFO("manual move added: %dum at %dum/s\n", move.x, move.f);
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            }
            else
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
            }
        }
        else
        {
            responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        }
        break;
    }
    case IO_PROTOCOL_WRITE_TYPE_TEST_MOVE:
    {
        // Decode G-code into move structure
        app_motion_move_t move = {0};
        DEBUG_INFO("Recieved G-code: %s\n", app_message_slave_data.dataRX);
        if (IO_gcode_decodeMove(app_message_slave_data.dataRX, &move))
        {
            if (app_motion_addTestMove(&move))
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            }
            else
            {
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
            }
        }
        else
        {
            responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        }
        break;
    }
    case IO_PROTOCOL_WRITE_TYPE_SAMPLE_PROFILE:
    {
        DEBUG_INFO("%s", "Receiving sample profile\n");
        SampleProfile sampleProfile;
        if (json_to_sample_profile(&sampleProfile, app_message_slave_data.dataRX))
        {
            DEBUG_INFO("Sample profile: maxForce=%u, maxVelocity=%u, maxDisplacement=%u, sampleWidth=%u, serialNumber=%u\n",
                       sampleProfile.maxForce,
                       sampleProfile.maxVelocity,
                       sampleProfile.maxDisplacement,
                       sampleProfile.sampleWidth,
                       sampleProfile.serialNumber);

            if (app_control_setSampleProfile(&sampleProfile))
            {
                DEBUG_INFO("%s", "Sample profile set successfully\n");
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK;
            }
            else
            {
                DEBUG_ERROR("%s", "Failed to set sample profile\n");
                responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
            }
        }
        else
        {
            DEBUG_ERROR("%s", "Failed to parse sample profile\n");
            responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK;
        }
        break;
    }
    case IO_PROTOCOL_WRITE_TYPE_GAUGE_LENGTH:
        DEBUG_INFO("%s", "Setting gauge length\n");
        app_monitor_zeroGaugeLength(); // zero encoder feedback
        break;
    case IO_PROTOCOL_WRITE_TYPE_GAUGE_FORCE:
        DEBUG_INFO("%s", "Setting gauge force\n");
        app_monitor_zeroGaugeForce();
        break;
    case IO_PROTOCOL_WRITE_TYPE_COUNT:
    default:
        break;
    }

    return responseType;
}

static void app_message_slave_private_handleIncomming()
{
    uint32_t dataSize = 0U;
    IO_protocol_readType_E readType = IO_PROTOCOL_READ_TYPE_COUNT;
    IO_protocol_writeType_E writeType = IO_PROTOCOL_WRITE_TYPE_COUNT;
    app_message_slave_responseType_E responseType = APP_MESSAGE_SLAVE_RESPONSE_TYPE_NONE;
    switch (IO_protocol_recieveRequest(&readType, &writeType, app_message_slave_data.dataRX, &dataSize, sizeof(app_message_slave_data.dataRX)))
    {
    case IO_PROTOCOL_INCOMMING_TYPE_READ:
        // DEBUG_INFO("Recieved read: %d\n", readType);
        responseType = app_message_slave_private_handleRead(readType);
        break;
    case IO_PROTOCOL_INCOMMING_TYPE_WRITE:
        // DEBUG_INFO("Recieved write: .%s.\n", app_message_slave_data.dataRX);
        responseType = app_message_slave_private_handleWrite(writeType, app_message_slave_data.dataRX, dataSize);
        break;
    case IO_PROTOCOL_INCOMMING_TYPE_NONE:
    default:
        break;
    }
    const uint16_t len = LIB_UTILITY_LIMIT(strlen(app_message_slave_data.dataTX), 0, 65535);
    switch (responseType)
    {
    case APP_MESSAGE_SLAVE_RESPONSE_TYPE_ACK:
        IO_protocol_respondACK(writeType);
        break;
    case APP_MESSAGE_SLAVE_RESPONSE_TYPE_NACK:
        IO_protocol_respondNACK(writeType);
        break;
    case APP_MESSAGE_SLAVE_RESPONSE_TYPE_DATA:
        IO_protocol_respondData(readType, (uint8_t *)app_message_slave_data.dataTX, len);
        break;
    case APP_MESSAGE_SLAVE_RESPONSE_TYPE_NONE:
    default:
        break;
    }
}

static void app_messageSlave_private_stageOutputs()
{
    APP_MESSAGESLAVE_LOCK_REQ_BLOCK();
    memcpy(&app_message_slave_data.output, &app_message_slave_data.stagedOutput, sizeof(app_message_slave_output_S));
    APP_MESSAGESLAVE_LOCK_REL();
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void app_messageSlave_init(int lock)
{
    app_message_slave_data.lock = lock;
    dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &app_message_slave_data.machineProfile, sizeof(MachineProfile));
}

void app_messageSlave_run()
{
    app_message_slave_private_handleIncomming();
    app_messageSlave_private_stageOutputs();
}

bool app_messageSlave_triggerTest(void)
{
    APP_MESSAGESLAVE_LOCK_REQ_BLOCK();
    bool triggerTest = app_message_slave_data.output.triggerTest;
    APP_MESSAGESLAVE_LOCK_REL();
    return triggerTest;
}

/**********************************************************************
 * End of File
 **********************************************************************/
