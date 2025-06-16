#include "propeller2.h"
#include <pthread.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include "smartpins.h"
#include "SocketIO.h"
#include "IO_Debug.h"

#define TIME_SCALING_FACTOR 1
#define CLOCK_FREQ 180000000
#define MAX_COGS 8
static pthread_t __cogs[MAX_COGS];
static bool __cog_running[MAX_COGS] = {false};
static volatile uint32_t __microseconds = 0;

#define MAX_LOCKS 32
static pthread_mutex_t __locks[MAX_LOCKS];

typedef struct
{
    uint32_t mode;
    uint32_t xval;
    uint32_t yval;
    int32_t socket_id;
    uint8_t state;
} GPIO;

static GPIO __gpio[64] = {0};

int32_t get_pin_socketid(int pin)
{
    return __gpio[pin].socket_id;
}

// New thread function to increment the microseconds counter
static void *incrementMicroseconds(void *arg)
{
    struct timespec start, current;
    uint64_t elapsedMicroseconds;

    // Get the starting time
    clock_gettime(CLOCK_MONOTONIC, &start);

    while (1)
    {
        // Get the current time
        clock_gettime(CLOCK_MONOTONIC, &current);

        // Calculate the elapsed time in microseconds
        elapsedMicroseconds = (current.tv_sec - start.tv_sec) * 1000000 +
                              (current.tv_nsec - start.tv_nsec) / 1000;

        // Update the microseconds counter
        __microseconds = elapsedMicroseconds;

        // Sleep for a short period to reduce CPU usage
        usleep(1000); // Sleep for 1 millisecond
    }
}

// Initialization function to start the microseconds incrementing thread
void init_simulator()
{
    pthread_t thread;
    if (pthread_create(&thread, NULL, incrementMicroseconds, NULL) != 0)
    {
        perror("Error creating microseconds incrementing thread");
        exit(EXIT_FAILURE);
    }
    for (uint8_t pin = 0; pin < 64; pin++)
    {
        __gpio[pin].socket_id = socketio_create_socket(pin);

        if (__gpio[pin].socket_id == -1)
        {
            perror("Error creating socket for pin");
            exit(0);
        }
        _waitms(10);
    }
}

int _locknew()
{
    static int lock_index = 0; // Index of the next available mutex

    if (lock_index < MAX_LOCKS)
    {
        // Initialize the mutex at the current index
        if (pthread_mutex_init(&__locks[lock_index], NULL) != 0)
        {
            // Mutex initialization failed
            return -1;
        }

        // Increment the index for the next mutex
        return lock_index++;
    }

    // Return -1 if the maximum number of mutexes has been reached
    return -1;
}

void _lockret(int lock)
{
    // Not adding, more complexity than it's worth
}

// this should work if same thread tries to lock twice (rlock???). might have library we can use in c
int _locktry(int lock)
{
    // this is fun, flexprop returns 0 on failure, pthread returns 0 on success
    return pthread_mutex_trylock(&__locks[lock]) == 0 ? 1 : 0;
}

int _lockrel(int lock)
{
    pthread_mutex_unlock(&__locks[lock]);
    return 0;
}

int _lockchk(int lock)
{
    if (pthread_mutex_trylock(&__locks[lock]) == 0)
    {
        pthread_mutex_unlock(&__locks[lock]);
        return 1;
    }
    return 0;
}

uint32_t _getms()
{
    return (uint32_t)(__microseconds / 1000);
}

// Modified _getus to use the global microseconds variable
uint32_t _getus()
{
    return (uint32_t)(__microseconds);
}

uint32_t _cnt()
{
    return (uint32_t)(__microseconds) * (CLOCK_FREQ / 1000000);
}

void _waitx(uint32_t cycles)
{
    usleep((1000000 * cycles) / (CLOCK_FREQ)); // Sleep for the specified number of cycles
}
void _waitsec(uint32_t seconds)
{
    usleep(seconds * 1000000); // Sleep for the specified number of seconds
}
void _waitms(uint32_t milliseconds)
{
    usleep(milliseconds * 1000); // Sleep for the specified number of milliseconds
}
void _waitus(uint32_t microseconds)
{
    usleep(microseconds); // Sleep for the specified number of microseconds
}

// Wrapper for _cogstart
int _cogstart(void (*func)(void *), void *arg, void *stack_base, uint32_t stack_size)
{
    // Find the next available cog
    uint8_t cog = MAX_COGS;
    for (uint8_t i = 0; i < MAX_COGS; i++)
    {
        if (__cog_running[i] == false)
        {
            cog = i;
            break;
        }
    }

    if (cog == MAX_COGS)
    {
        return -1; // No available cogs
    }

    pthread_t thread;
    pthread_attr_t attr;

    // Initialize pthread attributes
    pthread_attr_init(&attr);

    // Set the stack address and size for the new thread
    pthread_attr_setstack(&attr, stack_base, stack_size);

    // Create and start the new pthread
    if (pthread_create(&thread, &attr, (void *_Nullable (*_Nonnull)(void *_Nullable))func, (void *)arg) != 0)
    {
        return -1; // Error occurred
    }

    // Clean up pthread attributes
    pthread_attr_destroy(&attr);

    // Save the pthread_t for the new thread
    __cogs[cog] = thread;
    __cog_running[cog] = true;

    return 0; // Success
}

void _cogstop(int cog)
{
    if (__cog_running[cog])
    {
        __cog_running[cog] = false;
        // pthread_cancel(__cogs[cog]);
        pthread_join(__cogs[cog], NULL);
    }
}

void _pinw(int pin, int val)
{
    socketio_send(__gpio[pin].socket_id, val);
}

void _pinl(int pin)
{
    socketio_send(__gpio[pin].socket_id, 0);
}

void _pinh(int pin)
{
    socketio_send(__gpio[pin].socket_id, 1);
}

void _pinnot(int pin)
{
    // @TODO implement
}

void _pinrnd(int pin)
{
    // @TODO implement
}

void _pinf(int pin)
{
    // @TODO implement
}

int _pinr(int pin)
{
    int pin_state = 0;
    if (__gpio[pin].mode == P_ASYNC_RX)
    {
        // Check if there is data in the queue
        pin_state = socketio_poll(__gpio[pin].socket_id);
    }
    else if (__gpio[pin].mode == (P_OE | P_ASYNC_TX))
    {
        pin_state = 1; // flush buffer
    }
    else
    {
        if (socketio_poll(__gpio[pin].socket_id))
        {
            uint8_t buffer[1];
            int bytes_received = 0;
            bytes_received = socketio_receive(__gpio[pin].socket_id, buffer, 1);
            __gpio[pin].state = buffer[0];
            DEBUG_INFO("Bytes received on pin %d: %d\n", pin, bytes_received);
        }

        // The last byte received is in buffer[0]
        pin_state = __gpio[pin].state;
    }
    return pin_state;
}

void _wrpin(int pin, uint32_t val)
{
    // @TODO implement
}

void _wxpin(int pin, uint32_t val)
{
    // @TODO implement
}

void _wypin(int pin, uint32_t val)
{
    socketio_send(__gpio[pin].socket_id, (uint8_t)val);
}

void _akpin(int pin)
{
    // @TODO implement
}

uint32_t _rdpin(int pin)
{
    if (__gpio[pin].mode == P_ASYNC_RX)
    {
        // Check if there is data in the queue
        uint8_t data = 0;
        socketio_receive(__gpio[pin].socket_id, &data, 1);
        return (uint32_t)data << 24;
    }
    else
    {
        // perror("Error reading pin, not implemented");
    }
    return 0;
}

uint32_t _rqpin(int pin)
{
    // @TODO implement
    return 0;
}

void _pinstart(int pin, uint32_t mode, uint32_t xval, uint32_t yval)
{
    // Currently only used for force gauge, soft implementation
    if (mode == P_ASYNC_RX)
    {
        __gpio[pin].mode = mode;
        DEBUG_INFO("Starting pin RX: %d\n", pin);
    }
    else if (mode == (P_OE | P_ASYNC_TX))
    {
        __gpio[pin].mode = mode;
        DEBUG_INFO("Starting pin TX: %d\n", pin);
    }
    else
    {
        perror("Error starting pin, not implemented");
    }
}

void _pinclear(int pin)
{
    // Currently only used for force gauge, soft implementation
    if (__gpio[pin].mode == P_ASYNC_RX)
    {
        DEBUG_INFO("Clearing pin RX: %d\n", pin);
        __gpio[pin].mode = 0;
        // socketio_close(__gpio[pin].socket_id);
    }
    else if (__gpio[pin].mode == (P_OE | P_ASYNC_TX))
    {
        DEBUG_INFO("Clearing pin TX: %d\n", pin);
    }
    else
    {
        // perror("Error clearing pin, not implemented");
    }
}

uint32_t _clockfreq()
{
    return CLOCK_FREQ;
}

uint32_t _clockmode()
{
    perror("Error getting clock mode, not implemented");
    return 0;
}

// Makes new directory if it doesn't exist for "sd card" files to exist in
int mount(char *user_name, void *v)
{
    struct stat st = {0};
    if (stat(user_name, &st) != -1)
    {
        return -1;
    }
    mkdir(user_name, 0755); // Create the directory with read/write/execute permissions for owner and read/execute permissions for group and others

    FILE *fptr = fopen("_mount.lock", "r");

    if (fptr != NULL)
    {
        fclose(fptr); // Close the lock file
        return -1; // "sd card" already mounted, error
    }

    fptr = fopen("_mount.lock", "w"); // Create the lock file

    if (fptr == NULL)
    {
        return -1; // Error creating lock file
    }

    fclose(fptr); // Close the lock file

    return 0;
}

int umount(char *user_name)
{
    FILE *fptr = fopen("_mount.lock", "r");
    if (fptr == NULL) // if file does not exist
    {
        return -1; // "sd card" already mounted, error
    }
    fclose(fptr);          // Close the lock file
    remove("_mount.lock"); // Remove the lock file
    return 0;
}

void *_vfs_open_sdcard()
{
    return NULL;
}

void _reboot()
{
    DEBUG_INFO("%s", "Rebooting...\n");
    exit(0);
}
