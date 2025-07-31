# SIL Testing Documentation

This document describes the Software-in-the-Loop (SIL) testing framework for MaD Control, designed to enable comprehensive automated testing of the Electron application.

## Overview

The SIL testing framework provides:
- **Automated UI testing** with Playwright
- **Firmware emulation integration** using virtual serial ports
- **Profile and file management testing**
- **Screenshot capture** for visual verification
- **CI/CD integration** with GitHub Actions

## Test Suites

### 1. App Screenshots Test (`app-screenshots.spec.ts`)
- **Purpose**: Visual verification of all UI pages
- **Features**:
  - Screenshots of all navigation pages in disconnected state
  - Serial port connection testing with firmware emulation
  - Screenshots of all navigation pages in connected state
  - Automatic navigation drawer interaction

### 2. Profile Management Test (`profile-management.spec.ts`)
- **Purpose**: End-to-end testing of profile creation and file operations
- **Features**:
  - Sample test profile creation
  - Motion profile configuration
  - G-code preview generation
  - File save/load functionality testing
  - Step-by-step screenshot documentation

## Quick Start

### Prerequisites
- Node.js (LTS version)
- Python 3.x
- PlatformIO CLI (installed automatically by workflow)

### Local Development Testing

```bash
# Navigate to MaD Control directory
cd Software/MaDControl

# Install dependencies
npm ci

# Build the application (required for Electron testing)
npm run build

# Run all SIL tests
npm run test:sil

# Run tests with visible browser (debugging)
npm run test:sil:headed

# Run specific test suites
npm run test:screenshots    # App screenshots only
npm run test:profiles      # Profile management only

# Interactive debugging
npm run test:sil:debug
```

### CI/CD Testing

The SIL tests run automatically on:
- Push to `main` or `develop` branches
- Pull requests targeting `main` or `develop` branches
- When files in `Software/MaDControl/**` are modified

Results are uploaded as artifacts containing:
- **Logs**: Firmware emulator logs, Playwright test logs
- **Screenshots**: Visual evidence of test execution

## Test Configuration

### Playwright Configuration
The tests use the following Playwright configuration:
- **Headless mode**: Enabled for CI environments
- **Virtual display**: Xvfb for Linux environments
- **Electron-specific**: Custom launch arguments for security

### Firmware Emulation
- **Virtual Serial Ports**: Created using `socat`
- **Port Locations**: `/tmp/tty.rpi_client` and `/tmp/tty.rpi`
- **Emulator**: Built and run using Firmware/MaDCore/Emulation makefile
- **Fallback**: Tests continue even if firmware emulation fails

## Architecture

### Workflow Structure
1. **Environment Setup**: Install dependencies and system packages
2. **Firmware Emulation**: Create virtual environment and start emulator
3. **Application Build**: Compile MaD Control for testing
4. **Test Execution**: Run Playwright tests with virtual display
5. **Artifact Collection**: Gather logs and screenshots

### Test Helper Functions
- `openDrawerIfExists()`: Handles navigation drawer interaction
- `navigateToPage()`: Common navigation functionality
- `takeScreenshot()`: Standardized screenshot capture
- `screenshotAllPages()`: Bulk page screenshot capture

## Troubleshooting

### Common Issues

**Build Failures**:
- Ensure `npm ci` is run before testing
- Check Node.js version compatibility

**Firmware Emulation Issues**:
- Verify PlatformIO CLI installation
- Check virtual serial port creation (`/tmp/tty.rpi_client`)
- Review firmware emulator logs in artifacts

**Screenshot Issues**:
- Confirm virtual display (Xvfb) is running
- Check Electron app launch arguments
- Verify navigation elements exist

### Debug Mode
For interactive debugging:
```bash
npm run test:sil:debug
```
This opens the Playwright test inspector for step-by-step execution.

## File Structure

```
tests/e2e/
├── app-screenshots.spec.ts     # UI navigation and connection testing
├── profile-management.spec.ts  # Profile creation and file operations
└── helpers/                    # Future helper modules
```

## Extending Tests

To add new test suites:

1. Create new `.spec.ts` file in `tests/e2e/`
2. Follow existing patterns for app launch and setup
3. Use helper functions for common operations
4. Add screenshot capture for visual verification
5. Update npm scripts in `package.json` if needed

## Best Practices

- **Idempotent Tests**: Each test should be independent
- **Error Handling**: Use try-catch with screenshot capture
- **Wait Strategies**: Use `waitForSelector()` and `waitForLoadState()`
- **Screenshot Documentation**: Capture key steps for debugging
- **Cleanup**: Ensure proper resource cleanup in `afterAll()`

## Integration with Development Workflow

The SIL testing framework enables:
- **Automated regression testing** on code changes
- **Visual verification** of UI modifications
- **Hardware simulation** without physical devices
- **Continuous integration** with detailed reporting
- **Developer debugging** with comprehensive logs and screenshots

This testing approach ensures high-quality releases and enables confident development iteration.