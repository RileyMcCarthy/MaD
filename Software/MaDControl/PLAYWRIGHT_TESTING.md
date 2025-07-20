# Playwright Setup for MaD Control Debugging

This setup allows Copilot coding agents to use Playwright to view and debug the MaD Control Electron application.

## Quick Start

1. **Build the app** (required before testing):
   ```bash
   cd Software/MaDControl
   npm run build
   ```

2. **Take screenshots of the app**:
   ```bash
   npm run test:e2e
   ```

3. **Run with visible browser** (for debugging):
   ```bash
   npm run test:e2e:headed
   ```

## What This Does

- Opens the MaD Control Electron app
- Takes screenshots of the main application interface  
- Saves screenshots as PNG files for inspection
- Provides console output with basic app information

## Screenshot Files

The test generates these screenshot files:
- `proof-main-interface.png` - Main application interface
- `proof-final-state.png` - Final application state

## For Copilot Debugging

This setup enables Copilot to:
- Visually inspect the current state of the Electron app
- Understand the UI layout and components
- Debug visual issues when adding new features
- Verify that changes render correctly

## Environment

The tests run in a headless environment with Xvfb for CI/CD compatibility while still generating useful screenshots for debugging.