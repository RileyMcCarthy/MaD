# MaD Test Coverage Roadmap

This document outlines all features that need testing in the MaD tensile testing machine application. Tests are organized by category with status indicators.

## Legend
- ✅ = Covered by existing tests
- 🔄 = Partially covered
- ❌ = Not yet tested
- 🔧 = Requires firmware/hardware support

---

## 1. Application Launch & Connection

### Basic Startup
- ✅ Application launches successfully
- ✅ Main window displays correctly
- ✅ Sidebar navigation is visible
- ✅ All pages are accessible via navigation

### Serial Port Connection
- ✅ List available serial ports
- ✅ Connect to serial port
- ✅ Verify device responds after connection
- ✅ Handle connection to invalid port
- ❌ Handle device disconnection during operation
- ❌ Auto-reconnect after device reset
- ❌ Multiple connection attempts with retry logic
- ❌ Timeout handling for unresponsive devices

---

## 2. Dashboard Page

### Machine Status Display
- ✅ Machine Status panel displays all fields
- ✅ Disabled Reason field visible
- ✅ Restricted Reason field visible
- ✅ Motion State field visible
- ✅ Test State field visible
- ✅ Status values update in real-time

### Sample Data Parameters
- ✅ Machine Force (N) displays
- ✅ Machine Position (mm) displays
- ❌ Sample Force calculation (using gauge length)
- ❌ Sample Strain calculation (using gauge length)
- ❌ Stress calculation (using sample dimensions)

### Charts
- ✅ Charts render correctly
- ✅ Clear chart data button works
- ✅ Force vs Time chart updates during motion
- ✅ Position vs Time chart updates during motion
- ❌ Stress-Strain chart updates during test
- ❌ Chart auto-scaling based on sample profile limits
- ❌ Chart data persistence during navigation

### Motion Control Buttons
- ✅ Move Up button visible and clickable
- ✅ Move Down button visible and clickable
- ✅ Home button visible
- ✅ Zero Force button visible
- ✅ Zero Length button visible
- ✅ Enable/Disable Motion toggle works
- ✅ Move distance input accepts values
- ✅ Move speed input accepts values

---

## 3. Motion Control

### Manual Movement
- ✅ Enable motion via button
- ✅ Disable motion via button
- ✅ Move up with specified distance and speed
- ✅ Move down with specified distance and speed
- ✅ Position updates during movement
- ✅ Stopping motion mid-move (via disable)
- ❌ Maximum velocity limiting
- ❌ Movement at different speeds (slow, medium, fast)
- ❌ Continuous jog mode (hold button to move)

### Homing
- ❌ Home axis command
- ❌ Verify position resets to zero after homing
- ❌ Homing direction (towards lower endstop)
- 🔧 Homing with endstop detection

### Zeroing
- ❌ Zero force command
- ❌ Verify force reads zero after zeroing
- ❌ Zero length command
- ❌ Verify position reads zero after zeroing

---

## 4. Safety Features

### Faults
- ❌ COG (core/cog manager) fault handling
- ❌ Watchdog fault handling
- 🔧 ESD power fault detection
- 🔧 ESD switch fault detection
- 🔧 ESD upper limit fault detection
- 🔧 ESD lower limit fault detection
- ❌ Servo communication fault handling
- ❌ Force gauge communication fault handling
- ❌ Fault recovery procedures
- ❌ UI displays fault reason correctly

### Restrictions
- ❌ Sample length restriction (over max displacement)
- ❌ Sample tension restriction (over max force)
- ❌ Machine tension restriction (over machine max force)
- 🔧 Upper endstop restriction
- 🔧 Lower endstop restriction
- 🔧 Door interlock restriction
- ❌ Restriction reason displays in UI
- ❌ Motion limited when restricted

### Emergency Stop
- 🔧 Hardware E-stop functionality
- ❌ Software disable during test
- ✅ Motion stops when disabled

---

## 5. Profile Creation (Create Page)

### Sample Profile
- ✅ Sample Profile form displays
- ✅ All input fields visible (force, velocity, displacement, width, thickness, serial)
- ✅ Fill in sample profile values
- ✅ Load sample profile from .sp file
- ❌ Save sample profile to .sp file
- ❌ Validate input ranges (no negative values, etc.)
- ❌ Clear/reset form

### Motion Profile
- ✅ Motion Profile form displays
- ✅ Add Set button works
- ✅ Add Move button works
- ✅ Load motion profile from .mp file
- ✅ Preview G-code generation
- ❌ Save motion profile to .mp file
- ❌ Delete set from profile
- ❌ Delete move from set
- ❌ Reorder sets
- ❌ Reorder moves within set
- ❌ Edit execution count for set
- ❌ Edit move parameters

### Move Types
- ✅ Linear move type
- ✅ Dwell move type
- ❌ Circular CW move type
- ❌ Circular CCW move type
- ❌ Math function move type (if implemented)
- ❌ Absolute vs Relative positioning toggle

---

## 6. Test Execution

### Test Runner Dialog
- ✅ Open Run Test dialog
- ✅ Load sample profile in Test Runner
- ✅ Load motion profile in dialog
- ✅ Run Test button triggers test
- ✅ Test Running indicator displays
- ✅ Test completes successfully
- ❌ Cancel/abort running test
- ❌ Test name input and validation
- ❌ Test progress indicator (current line / total lines)

### G-Code Execution
- ✅ G-code streams to firmware
- ✅ G122 STOP command signals test complete
- ❌ G0 rapid move execution
- ❌ G1 linear move execution
- ❌ G4 dwell execution with timing
- ❌ G28 home during test
- ❌ G90/G91 absolute/relative mode switching
- ❌ Error handling for invalid G-code

### Data Recording
- ❌ Sample data recording during test
- ❌ Data export to CSV
- ❌ Data export to JSON
- ❌ Timestamped data points
- ❌ Test run metadata (date, sample profile, motion profile)

---

## 7. Machine Configuration Page

### Machine Profile
- ❌ Display current machine configuration
- ❌ Edit machine name
- ❌ Edit max force limit
- ❌ Edit max velocity limit
- ❌ Edit max position limit
- ❌ Save machine configuration to device
- ❌ Load machine configuration from device

### Calibration
- ❌ Force gauge calibration
- ❌ Position sensor calibration
- ❌ Calibration data persistence

---

## 8. Firmware Update Page

### Firmware Info
- ❌ Display current firmware version
- ❌ Check for updates

### Firmware Flash
- ❌ Flash firmware from file
- ❌ Progress indicator during flash
- ❌ Cancel firmware flash
- ❌ Error handling for failed flash
- ❌ Verify firmware version after update

---

## 9. Error Handling & Edge Cases

### Communication Errors
- ❌ Handle serial port disconnection
- ❌ Handle corrupted JSON messages
- ❌ Handle timeout on G-code acknowledgment
- ❌ Retry logic for failed commands
- ❌ Display user-friendly error messages

### UI Edge Cases
- ❌ Window resize behavior
- ❌ Rapid button clicks (debouncing)
- ❌ Navigation during active test
- ❌ Form validation error messages
- ❌ Input field boundary values (0, negative, very large)

### Firmware Edge Cases
- ❌ Move command at position limits
- ❌ Force near maximum limit
- ❌ Very fast vs very slow movements
- ❌ Long-running test (hours)
- ❌ Rapid start/stop cycles

---

## 10. Data Persistence

### File Operations
- ✅ Load sample profile from file
- ✅ Load motion profile from file
- ❌ Save sample profile to file
- ❌ Save motion profile to file
- ❌ Recent files list
- ❌ Default save locations

### Application State
- ❌ Remember last connected port
- ❌ Remember window size/position
- ❌ Remember last used profiles

---

## 11. Notifications

### Toast Notifications
- ❌ Success notifications display
- ❌ Error notifications display
- ❌ Warning notifications display
- ❌ Info notifications display
- ❌ Notifications auto-dismiss
- ❌ Notification history/log

### Firmware Notifications
- ❌ Test complete notification from firmware
- ❌ Fault notification from firmware
- ❌ Restriction notification from firmware

---

## 12. Performance & Reliability

### Real-time Performance
- ❌ Sample data updates at expected rate (Hz)
- ❌ Chart renders without lag
- ❌ UI remains responsive during test
- ❌ No memory leaks during long sessions

### Stress Tests
- ❌ Run multiple tests in sequence
- ❌ Rapid connect/disconnect cycles
- ❌ Large motion profile execution
- ❌ Extended operation (hours)

---

## Test Count Summary

| Category | Tested | Partial | Not Tested | Hardware |
|----------|--------|---------|------------|----------|
| Launch & Connection | 6 | 0 | 4 | 0 |
| Dashboard | 12 | 0 | 5 | 0 |
| Motion Control | 8 | 0 | 5 | 1 |
| Safety Features | 1 | 0 | 9 | 6 |
| Profile Creation | 9 | 0 | 10 | 0 |
| Test Execution | 6 | 0 | 10 | 0 |
| Machine Config | 0 | 0 | 8 | 0 |
| Firmware Update | 0 | 0 | 6 | 0 |
| Error Handling | 0 | 0 | 14 | 0 |
| Data Persistence | 2 | 0 | 6 | 0 |
| Notifications | 0 | 0 | 9 | 0 |
| Performance | 0 | 0 | 8 | 0 |
| **Total** | **44** | **0** | **94** | **7** |

---

## Priority Recommendations

### High Priority (Critical Path)
1. ❌ Test cancellation/abort functionality
2. ❌ Data export (CSV/JSON)
3. ❌ Error handling for communication failures
4. ❌ Home axis functionality
5. ❌ Zero force/length functionality

### Medium Priority (User Experience)
1. ❌ Save profiles to file
2. ❌ Firmware version display
3. ❌ Notifications system
4. ❌ Input validation
5. ❌ Chart auto-scaling

### Lower Priority (Nice to Have)
1. ❌ Recent files list
2. ❌ Window state persistence
3. ❌ Extended stress testing
4. ❌ Performance optimization

---

## Notes for Test Development

### SIL Limitations
Some features require actual hardware and cannot be tested in SIL:
- Hardware ESD (emergency stop) buttons
- Physical endstops
- Door interlock sensors
- Real force gauge readings
- Real motor movement

For these, use emulator simulation or mock responses where possible.

### Test Fixtures
Standard test fixtures are available in `SIL/test-fixtures/`:
- `sample-profile.sp` - Basic sample profile for testing
- `motion-profile-simple.mp` - Simple 3-move test
- `motion-profile-complex.mp` - Multi-set complex test

### Adding New Tests
1. Identify the feature category
2. Check if it needs hardware (🔧) or can be emulated
3. Add test to appropriate spec file or create new one
4. Update this roadmap to mark as tested (✅)
