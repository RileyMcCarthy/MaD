# Microsoft Playwright MCP Integration for MaD Control

This setup enables AI coding assistants (Copilot, Claude, etc.) to interact with the MaD Control Electron application using Microsoft's official Playwright MCP (Model Context Protocol) server.

## What is Microsoft Playwright MCP?

Microsoft's `@playwright/mcp` is an official MCP server that provides browser automation through Playwright's accessibility tree instead of screenshots. This makes it:

- **Fast and lightweight** - Uses structured data, not pixels
- **LLM-friendly** - No vision models needed
- **Deterministic** - Avoids ambiguity of screenshot-based approaches  
- **Reliable** - Official Microsoft implementation

## Quick Start

### 1. Prerequisites

Ensure the MCP package is installed (already included):
```bash
npm install --save-dev @playwright/mcp
```

### 2. Configure Your AI Client

Use the configuration from `mcp-config.json`:

**For VS Code / Cursor / Windsurf:**
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx", 
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

**For Claude Desktop:**
Add to your MCP settings:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

### 3. Start Testing

Build and run the app:
```bash
npm run build
npm run start
```

Then use MCP tools in your AI assistant to interact with the app!

## Available MCP Tools

The Microsoft Playwright MCP provides these tools automatically:

### Core Tools
- `browser_navigate` - Navigate to URLs
- `browser_snapshot` - Get accessibility tree (recommended)
- `browser_take_screenshot` - Capture screenshots
- `browser_click` - Click elements
- `browser_type` - Type text
- `browser_hover` - Hover over elements
- `browser_wait_for` - Wait for conditions

### Advanced Tools
- `browser_select_option` - Select from dropdowns
- `browser_drag` - Drag and drop
- `browser_press_key` - Keyboard input  
- `browser_evaluate` - Execute JavaScript
- `browser_file_upload` - Upload files
- `browser_handle_dialog` - Handle dialogs

### Tab Management
- `browser_tab_new` - Create new tabs
- `browser_tab_select` - Switch tabs
- `browser_tab_close` - Close tabs
- `browser_tab_list` - List all tabs

### Debugging
- `browser_console_messages` - Get console logs
- `browser_network_requests` - Monitor network
- `browser_resize` - Resize window

## Usage Examples

### Basic App Testing
```javascript
// Navigate to the app
browser_navigate({ url: "http://localhost:1212" })

// Wait for app to load
browser_wait_for({ time: 2 })

// Get page structure (fastest way)
browser_snapshot()

// Take screenshot for documentation
browser_take_screenshot({ filename: "mad-control-main.png" })
```

### Form Testing
```javascript
// Fill serial port settings
browser_type({ element: "Port input", ref: "#serial-port-input", text: "COM3" })
browser_select_option({ element: "Baud rate", ref: "#baud-rate-select", values: ["115200"] })

// Connect
browser_click({ element: "Connect button", ref: "#connect-button" })
browser_wait_for({ time: 3 })

// Verify connection
browser_snapshot()
browser_take_screenshot({ filename: "connected-state.png" })
```

### Navigation Testing  
```javascript
// Test different sections
browser_click({ element: "Dashboard", ref: "[data-testid='nav-dashboard']" })
browser_wait_for({ time: 1 })
browser_take_screenshot({ filename: "dashboard.png" })

browser_click({ element: "Settings", ref: "[data-testid='nav-settings']" })
browser_wait_for({ time: 1 })
browser_take_screenshot({ filename: "settings.png" })
```

## Integration with Development

### For New Features
1. **Build the app**: `npm run build`
2. **Start the app**: `npm run start`
3. **Use MCP tools** to test your changes interactively
4. **Take screenshots** to document functionality
5. **Use snapshots** to verify accessibility structure

### For Bug Investigation
1. **Reproduce the issue** with MCP tools
2. **Capture evidence** with screenshots
3. **Monitor console** with `browser_console_messages`
4. **Check network** with `browser_network_requests`
5. **Document findings** for the bug report

### For PR Validation
1. **Build changes**: `npm run build`
2. **Test systematically** with MCP tools
3. **Compare before/after** screenshots
4. **Verify accessibility** with snapshots
5. **Document testing** in PR comments

## Configuration Files

### `mcp-config.json`
Standard MCP server configuration that works with most AI clients:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

### `playwright.config.ts`
Electron-specific Playwright configuration for testing.

## Best Practices

1. **Always use `browser_snapshot()` first** - It's the fastest way to understand the page structure
2. **Use descriptive screenshot filenames** - Makes debugging much easier
3. **Wait between actions** - Use `browser_wait_for()` to ensure UI updates complete
4. **Test edge cases** - Try invalid inputs and error conditions
5. **Monitor console output** - Catch JavaScript errors early
6. **Document with visuals** - Screenshots provide valuable evidence

## Troubleshooting

### MCP Server Issues
- **Tools not available**: Check your AI client's MCP configuration
- **Server won't start**: Ensure `@playwright/mcp` is installed
- **Permissions errors**: Try running with `npx @playwright/mcp@latest` manually

### App Testing Issues  
- **App won't load**: Ensure you ran `npm run build` first
- **Navigation fails**: Verify the URL is correct (usually `http://localhost:1212`)
- **Screenshots are blank**: Wait longer for app to load, use `browser_wait_for`
- **Elements not found**: Take a `browser_snapshot` to see available elements

### Common URLs
- **Development**: `http://localhost:1212` 
- **Built app**: `file:///path/to/MaDControl/release/app/dist/index.html`

## Example Testing Session

Here's a complete testing workflow using Microsoft Playwright MCP:

```javascript
// 1. Start testing session
browser_navigate({ url: "http://localhost:1212" })
browser_wait_for({ time: 3 })

// 2. Understand the interface  
browser_snapshot() // Shows all interactive elements

// 3. Document initial state
browser_take_screenshot({ filename: "initial-load.png" })

// 4. Test navigation
browser_click({ element: "Dashboard tab", ref: "[data-testid='nav-dashboard']" })
browser_wait_for({ time: 1 })
browser_take_screenshot({ filename: "dashboard.png" })

// 5. Test form interactions
browser_click({ element: "Settings tab", ref: "[data-testid='nav-settings']" })
browser_type({ element: "Port input", ref: "#serial-port-input", text: "COM3" })
browser_select_option({ element: "Baud rate", ref: "#baud-rate-select", values: ["115200"] })

// 6. Test functionality
browser_click({ element: "Connect button", ref: "#connect-button" })
browser_wait_for({ time: 2 })

// 7. Verify results
browser_snapshot() // Check final state
browser_take_screenshot({ filename: "test-complete.png" })
browser_console_messages() // Check for any errors
```

This integration provides a robust, official, and standardized way for AI assistants to interact with the MaD Control application for development, testing, and debugging.

## Why Use Microsoft's Playwright MCP?

- **Official Support**: Backed by Microsoft and the Playwright team
- **Regular Updates**: Stays current with Playwright developments
- **Better Performance**: Uses accessibility trees instead of screenshots
- **Industry Standard**: Follows MCP specifications exactly
- **Broad Compatibility**: Works with all major AI coding assistants
- **No Custom Code**: No maintenance burden on our project