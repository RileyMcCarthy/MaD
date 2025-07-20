# Microsoft Playwright MCP - Quick Reference

Quick reference for using Microsoft's official Playwright MCP tools with MaD Control.

## Setup Commands

```bash
# Build the application (required)
npm run build

# Start the application  
npm run start

# Alternative: Development server
npm run start:renderer
```

## Core MCP Tools

### Navigation & Page Control

```javascript
// Navigate to the app
browser_navigate({ url: "http://localhost:1212" })

// Take accessibility snapshot (recommended)
browser_snapshot()

// Take screenshot for documentation
browser_take_screenshot({ filename: "app-state.png" })

// Wait for content to load
browser_wait_for({ time: 2 })
browser_wait_for({ text: "Dashboard" })
```

### Element Interaction

```javascript
// Click elements
browser_click({ element: "Dashboard tab", ref: "[data-testid='nav-dashboard']" })

// Type in inputs  
browser_type({ element: "Serial port field", ref: "#serial-port", text: "COM3" })

// Hover over elements
browser_hover({ element: "Connect button", ref: "#connect-btn" })

// Select dropdown options
browser_select_option({ element: "Baud rate dropdown", ref: "#baud-rate", values: ["9600"] })
```

### Advanced Interactions

```javascript
// Press keyboard keys
browser_press_key({ key: "Enter" })
browser_press_key({ key: "Tab" })

// Drag and drop
browser_drag({ 
  startElement: "Source", startRef: "#source",
  endElement: "Target", endRef: "#target"
})

// Execute JavaScript
browser_evaluate({ function: "() => document.title" })
browser_evaluate({ function: "(element) => element.click()", element: "Button", ref: "#btn" })
```

### Tab Management

```javascript
// Open new tab
browser_tab_new({ url: "http://localhost:1212" })

// Switch tabs
browser_tab_select({ index: 0 })

// Close tab
browser_tab_close({ index: 1 })

// List all tabs
browser_tab_list()
```

### Debugging & Monitoring

```javascript
// Get console messages
browser_console_messages()

// Monitor network requests
browser_network_requests()

// Handle dialogs
browser_handle_dialog({ accept: true })
browser_handle_dialog({ accept: false })

// Resize browser window
browser_resize({ width: 1280, height: 720 })
```

## Common Testing Patterns

### Pattern 1: Basic App Test
```javascript
browser_navigate({ url: "http://localhost:1212" })
browser_wait_for({ time: 2 })
browser_snapshot()
browser_take_screenshot({ filename: "app-loaded.png" })
```

### Pattern 2: Navigation Test
```javascript
browser_click({ element: "Dashboard", ref: "[data-testid='nav-dashboard']" })
browser_wait_for({ time: 1 })
browser_snapshot()
browser_take_screenshot({ filename: "dashboard.png" })

browser_click({ element: "Settings", ref: "[data-testid='nav-settings']" })
browser_wait_for({ time: 1 })  
browser_take_screenshot({ filename: "settings.png" })
```

### Pattern 3: Form Testing
```javascript
browser_type({ element: "Port input", ref: "#port", text: "COM3" })
browser_select_option({ element: "Baud rate", ref: "#baud", values: ["115200"] })
browser_click({ element: "Connect", ref: "#connect-btn" })
browser_wait_for({ time: 2 })
browser_snapshot()
```

### Pattern 4: Responsive Testing
```javascript
// Desktop
browser_resize({ width: 1920, height: 1080 })
browser_take_screenshot({ filename: "desktop.png" })

// Tablet
browser_resize({ width: 768, height: 1024 })
browser_take_screenshot({ filename: "tablet.png" })

// Mobile
browser_resize({ width: 375, height: 667 })
browser_take_screenshot({ filename: "mobile.png" })
```

## MaD Control Specific Examples

### Testing Serial Port Connection
```javascript
// Navigate to main interface
browser_navigate({ url: "http://localhost:1212" })
browser_wait_for({ text: "Serial Port" })

// Configure connection
browser_type({ element: "Port field", ref: "#serial-port-input", text: "COM3" })
browser_select_option({ element: "Baud rate", ref: "#baud-rate-select", values: ["115200"] })

// Attempt connection
browser_click({ element: "Connect button", ref: "#connect-button" })
browser_wait_for({ time: 3 })

// Check connection status
browser_snapshot()
browser_take_screenshot({ filename: "serial-connected.png" })
```

### Testing Profile Management  
```javascript
// Go to profiles section
browser_click({ element: "Profiles tab", ref: "[data-testid='profiles-tab']" })
browser_wait_for({ text: "Test Profiles" })

// Create new profile
browser_click({ element: "New Profile", ref: "#new-profile-btn" })
browser_type({ element: "Profile name", ref: "#profile-name", text: "Test Profile 1" })
browser_click({ element: "Save", ref: "#save-profile-btn" })

// Verify profile created
browser_wait_for({ text: "Test Profile 1" })
browser_take_screenshot({ filename: "profile-created.png" })
```

### Testing Dashboard Widgets
```javascript
// Load dashboard
browser_navigate({ url: "http://localhost:1212" })
browser_click({ element: "Dashboard", ref: "[data-testid='nav-dashboard']" })

// Check widgets are present
browser_snapshot() // Will show all interactive elements

// Test widget interactions
browser_click({ element: "Force widget", ref: "[data-testid='force-widget']" })
browser_click({ element: "Position widget", ref: "[data-testid='position-widget']" })

// Document final state
browser_take_screenshot({ filename: "dashboard-widgets.png" })
```

## File Paths & URLs

### Development URLs
- Local server: `http://localhost:1212`
- Main window: `http://localhost:1212/index.html`  

### Built Application Paths
- Windows: `file:///C:/path/to/MaDControl/release/app/dist/index.html`
- Linux/Mac: `file:///absolute/path/to/MaDControl/release/app/dist/index.html`

## Tips for Effective Testing

1. **Always use `browser_snapshot()` first** - It's faster than screenshots and gives you element references
2. **Use descriptive filenames** for screenshots - Makes debugging easier
3. **Wait between actions** - Use `browser_wait_for()` to ensure UI updates  
4. **Test error states** - Try invalid inputs and edge cases
5. **Monitor console** - Check for JavaScript errors with `browser_console_messages()`
6. **Document with screenshots** - Visual proof is invaluable for PRs and bug reports

## Troubleshooting

- **"Element not found"** → Take a snapshot to see available elements
- **"Screenshots are blank"** → Wait longer or check if app is running
- **"Navigation fails"** → Verify the URL and build status
- **"Tools not working"** → Check MCP server configuration in your AI client
- `playwright-mcp-server-browser_console_messages` - Check for errors
- `playwright-mcp-server-browser_network_requests` - Monitor API calls

### 📱 Responsive Testing
- `playwright-mcp-server-browser_resize` - Test different screen sizes

## Common Workflows for New PRs

### Before Making Changes
1. **Take baseline screenshot:**
   ```
   playwright-mcp-server-browser_take_screenshot
   { "filename": "before-changes.png" }
   ```

2. **Navigate to feature area:**
   ```
   playwright-mcp-server-browser_click
   { "element": "Dashboard tab", "ref": "nav-dashboard" }
   ```

3. **Capture DOM structure:**
   ```
   playwright-mcp-server-browser_snapshot
   ```

### During Development
1. **Test form interactions:**
   ```
   playwright-mcp-server-browser_type
   { "element": "Test name", "ref": "input[name='testName']", "text": "Debug Test" }
   ```

2. **Validate dropdowns:**
   ```
   playwright-mcp-server-browser_select_option
   { "element": "Test type", "ref": "select[name='testType']", "values": ["Tensile Test"] }
   ```

3. **Check for errors:**
   ```
   playwright-mcp-server-browser_console_messages
   ```

### After Changes
1. **Take comparison screenshot:**
   ```
   playwright-mcp-server-browser_take_screenshot
   { "filename": "after-changes.png" }
   ```

2. **Test mobile responsiveness:**
   ```
   playwright-mcp-server-browser_resize
   { "width": 375, "height": 667 }
   ```

3. **Validate functionality:**
   ```
   playwright-mcp-server-browser_click
   { "element": "Submit button", "ref": "button[type='submit']" }
   ```

## Pre-built Helper Patterns

Instead of writing selectors manually, use `mcp-helpers.js` patterns:

```javascript
// Navigation
MCPHelpers.navigation.dashboard
MCPHelpers.navigation.create

// Screenshots  
MCPHelpers.screenshots.initial
MCPHelpers.screenshots.afterAction("form-submit")

// Form interactions
MCPHelpers.forms.createTest.name
MCPHelpers.forms.createTest.submit

// Debugging
MCPHelpers.debug.getAllElements
MCPHelpers.debug.getFormData

// Responsive testing
MCPHelpers.responsive.mobile
MCPHelpers.responsive.desktop
```

## Real-world Example

Testing a new form validation feature:

1. **Navigate & capture baseline:**
   ```
   playwright-mcp-server-browser_navigate 
   -> playwright-mcp-server-browser_click (Create Test tab)
   -> playwright-mcp-server-browser_take_screenshot ("baseline.png")
   ```

2. **Test validation (empty form):**
   ```
   playwright-mcp-server-browser_click (Submit button)
   -> playwright-mcp-server-browser_evaluate (check for error messages)
   -> playwright-mcp-server-browser_take_screenshot ("validation-errors.png")
   ```

3. **Test successful submission:**
   ```
   playwright-mcp-server-browser_type (fill form)
   -> playwright-mcp-server-browser_select_option (select type)
   -> playwright-mcp-server-browser_click (submit)
   -> playwright-mcp-server-browser_take_screenshot ("success.png")
   ```

4. **Verify mobile layout:**
   ```
   playwright-mcp-server-browser_resize (mobile size)
   -> playwright-mcp-server-browser_take_screenshot ("mobile-view.png")
   ```

## Benefits for Development

✅ **Immediate Visual Feedback** - See changes instantly  
✅ **No Test Setup Required** - Direct MCP tool usage  
✅ **Real App Testing** - Test actual Electron app, not mocks  
✅ **Responsive Validation** - Test all screen sizes  
✅ **Error Detection** - Catch JavaScript/console errors  
✅ **Before/After Comparison** - Visual regression detection  

Use these tools to ensure every PR maintains quality and doesn't break existing functionality.