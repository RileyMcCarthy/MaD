# MCP Playwright Integration Guide for MaD Control

This document explains how to use the Microsoft Playwright MCP (Model Control Protocol) to interact with and debug the MaD Control Electron application. This setup enables Copilot coding agents to visually inspect, debug, and test the application interface.

## Quick Start for MCP Usage

### 1. Install and Configure MCP

The Playwright MCP server is configured via `mcp-config.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp"]
    }
  }
}
```

### 2. Launch the App for MCP Debugging

```bash
# Build the app first (required for Electron testing)
npm run build

# Start the MCP server
npm run mcp:server
```

### 3. Use MCP Tools for Interactive Debugging

Once the MCP server is running, you can use these tools:

- **browser_navigate**: Navigate to specific app sections
- **browser_snapshot**: Capture current app state  
- **browser_click**: Interact with UI elements
- **browser_type**: Enter text into forms
- **browser_take_screenshot**: Capture visual proof
- **browser_evaluate**: Run JavaScript in the app context

## MCP Integration Examples

### Visual Inspection
```javascript
// Take a screenshot of the current app state
await browser_take_screenshot({ filename: "current-state.png" });

// Capture accessibility tree for debugging
await browser_snapshot();
```

### Interactive Testing
```javascript
// Click on navigation elements
await browser_click({ 
  element: "Dashboard navigation button", 
  ref: "nav-dashboard" 
});

// Test form interactions
await browser_type({
  element: "Serial port input field",
  ref: "input-serial-port", 
  text: "COM3"
});
```

### App State Evaluation
```javascript
// Check current app state
await browser_evaluate({
  function: "() => window.location.href"
});

// Verify component render state
await browser_evaluate({
  function: "() => document.querySelector('.dashboard').innerText"
});
```

## Automated Screenshot Testing

The repository includes automated screenshot tests that capture each app page:

```bash
# Run screenshot tests
npm run test:screenshots

# View test results with UI
npm run test:playwright:ui
```

These tests automatically:
- Launch the Electron app with proper configuration
- Navigate to each app section 
- Wait for full page loading
- Capture high-quality screenshots
- Store results in `test-results/screenshots/`

## GitHub Actions Integration

The workflow automatically:
1. Builds the Electron app
2. Installs Playwright with system dependencies
3. Runs screenshot tests in headless mode
4. Uploads all screenshots as build artifacts
5. Provides visual proof of app functionality

View artifacts after each PR build to see:
- `app-screenshots-{run_number}`: Individual page screenshots
- `playwright-results-{run_number}`: Complete test reports

## MCP Development Workflow

For new feature development:

1. **Start MCP Server**: `npm run mcp:server`
2. **Use Visual Tools**: Take screenshots to understand current state
3. **Interactive Development**: Use MCP click/type tools to test changes
4. **Validation**: Capture before/after screenshots
5. **Automated Testing**: Run full screenshot suite to verify no regressions

## Configuration Files

- **playwright.config.ts**: Cleaned up configuration optimized for Electron testing
- **mcp-config.json**: MCP server configuration
- **.github/workflows/playwright-tests.yml**: CI/CD automation
- **tests/e2e/app-screenshots.spec.ts**: Screenshot test suite

## Troubleshooting

**App not launching in MCP?**
- Ensure `npm run build` completed successfully
- Check that Electron dependencies are installed with `npm run electron:install`

**Screenshots appearing blank?**
- Wait longer for app loading (tests include 3-second delays)
- Verify the build process completed without errors

**MCP tools not connecting?**
- Restart the MCP server: `npm run mcp:server`
- Check that port isn't blocked by firewall

This setup provides complete visual debugging capabilities for the MaD Control application, enabling efficient development and testing workflows.