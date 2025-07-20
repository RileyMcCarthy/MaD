# Microsoft Playwright MCP Integration for MaD Control

This guide shows how to use Microsoft's official Playwright MCP server to debug, test, and validate the MaD Control Electron application during development.

## What is Microsoft Playwright MCP?

Microsoft's Playwright MCP is an official Model Context Protocol server that provides browser automation capabilities using Playwright's accessibility tree, not pixel-based screenshots. This makes it fast, lightweight, and perfect for LLM-driven development.

## Setup

### 1. Install Dependencies

The MCP server is already installed in the project:
```bash
npm install --save-dev @playwright/mcp
```

### 2. Configure Your MCP Client

Use the configuration in `mcp-config.json`:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}
```

### 3. Build the Application

Before testing with MCP tools, build the application:
```bash
cd Software/MaDControl
npm run build
```

## Using Microsoft Playwright MCP Tools

### Available MCP Tools

The Microsoft Playwright MCP provides these tools through the MCP interface:

- **browser_navigate** - Navigate to URLs
- **browser_snapshot** - Capture accessibility snapshots
- **browser_click** - Click elements  
- **browser_type** - Type text into elements
- **browser_hover** - Hover over elements
- **browser_select_option** - Select dropdown options
- **browser_drag** - Drag and drop
- **browser_press_key** - Press keyboard keys
- **browser_take_screenshot** - Take screenshots
- **browser_evaluate** - Execute JavaScript
- **browser_wait_for** - Wait for conditions
- **browser_file_upload** - Upload files
- **browser_handle_dialog** - Handle dialogs
- **browser_tab_new** - Create new tabs
- **browser_tab_select** - Switch tabs
- **browser_tab_close** - Close tabs
- **browser_console_messages** - Get console logs
- **browser_network_requests** - Monitor network
- **browser_resize** - Resize browser window

### Testing the MaD Control App

#### 1. Launch the Application

First, start the Electron app in development mode:
```bash
npm run start
```

#### 2. Connect and Navigate

Using MCP tools in your AI coding assistant (VS Code, Cursor, etc.):

```
Tool: browser_navigate
Parameters: {
  "url": "file:///absolute/path/to/MaDControl/release/app/dist/index.html"
}
```

Or if testing the development server:
```
Tool: browser_navigate  
Parameters: {
  "url": "http://localhost:1212"
}
```

#### 3. Take Accessibility Snapshot

Get the current page structure:
```
Tool: browser_snapshot
```

This returns a structured accessibility tree that shows all interactive elements, perfect for understanding the app layout without screenshots.

#### 4. Test Navigation

Click on navigation elements:
```
Tool: browser_click
Parameters: {
  "element": "Dashboard navigation button",
  "ref": "[data-testid='nav-dashboard']"
}
```

#### 5. Test Form Interactions

Type in input fields:
```
Tool: browser_type
Parameters: {
  "element": "Serial port input field",
  "ref": "#serial-port-input",
  "text": "COM3"
}
```

#### 6. Capture Screenshots for Debugging

Take screenshots at key points:
```
Tool: browser_take_screenshot
Parameters: {
  "filename": "mad-control-dashboard.png"
}
```

### Common Testing Scenarios

#### Scenario 1: UI Navigation Testing

1. **Load the app** - Navigate to the application
2. **Take snapshot** - Get accessibility tree
3. **Click navigation** - Test different sections
4. **Verify content** - Check that sections load properly
5. **Take screenshots** - Document the current state

#### Scenario 2: Form Validation Testing  

1. **Navigate to settings** - Go to configuration page
2. **Fill forms** - Enter various input values
3. **Submit forms** - Test form submission
4. **Check responses** - Validate error/success messages
5. **Test edge cases** - Try invalid inputs

#### Scenario 3: Responsive Design Testing

1. **Resize window** - Test different screen sizes
2. **Take snapshots** - Check layout at each size  
3. **Test interactions** - Ensure UI remains functional
4. **Document issues** - Screenshot any problems

## Integration with Development Workflow

### For Feature Development

1. **Start development server**: `npm run start`
2. **Use MCP tools** to interact with your changes in real-time
3. **Take screenshots** to document new features
4. **Test accessibility** with snapshots to ensure proper structure
5. **Validate forms** and interactions

### For Bug Investigation  

1. **Reproduce the issue** using MCP tools
2. **Take screenshots** at each step
3. **Capture console logs** with `browser_console_messages`
4. **Monitor network requests** with `browser_network_requests`
5. **Document the bug** with evidence

### For Testing New PRs

1. **Build the changes**: `npm run build`
2. **Launch the app**: `npm run start`
3. **Use MCP tools** to test the PR changes
4. **Compare before/after** screenshots
5. **Validate functionality** with accessibility snapshots

## Best Practices

1. **Always build first** - Run `npm run build` before testing
2. **Use accessibility snapshots** - Faster and more reliable than screenshots
3. **Test systematically** - Follow consistent testing patterns
4. **Document with screenshots** - Visual proof of functionality
5. **Monitor console/network** - Catch issues early
6. **Test responsive design** - Verify different screen sizes

## Troubleshooting

### App Won't Load
- Ensure `npm run build` was successful
- Check that Electron app is running: `npm run start`
- Verify the file path in `browser_navigate`

### MCP Tools Not Working
- Make sure `@playwright/mcp` is installed
- Check your MCP client configuration
- Verify the MCP server is running

### Screenshots Are Blank
- Wait for app to fully load before taking screenshots
- Use `browser_wait_for` to wait for specific content
- Check that the Electron app window is visible

## Example Testing Session

```javascript
// 1. Navigate to app
browser_navigate({ url: "http://localhost:1212" })

// 2. Wait for app to load  
browser_wait_for({ time: 3 })

// 3. Take initial snapshot
browser_snapshot()

// 4. Take screenshot of main interface
browser_take_screenshot({ filename: "main-interface.png" })

// 5. Test navigation
browser_click({ element: "Settings tab", ref: "[data-testid='nav-settings']" })

// 6. Wait for page change
browser_wait_for({ time: 1 })

// 7. Take settings screenshot
browser_take_screenshot({ filename: "settings-page.png" })

// 8. Test form input
browser_type({ element: "Port input", ref: "#port-input", text: "COM3" })

// 9. Submit form
browser_click({ element: "Connect button", ref: "#connect-btn" })

// 10. Check final state
browser_snapshot()
browser_take_screenshot({ filename: "connected-state.png" })
```

This workflow provides comprehensive testing and debugging capabilities for the MaD Control application using Microsoft's official Playwright MCP tools.
```
Tool: playwright-mcp-server-browser_take_screenshot
Parameters: {
  "filename": "initial-app-state.png",
  "raw": false
}
```

**Capture the DOM structure:**
```
Tool: playwright-mcp-server-browser_snapshot
Parameters: {}
```

### 2. Navigation Testing

**Click on Dashboard tab:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Dashboard navigation tab",
  "ref": "nav-dashboard"
}
```

**Take screenshot after navigation:**
```
Tool: playwright-mcp-server-browser_take_screenshot
Parameters: {
  "filename": "dashboard-view.png"
}
```

**Navigate to Tests page:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Tests navigation tab", 
  "ref": "nav-tests"
}
```

### 3. Form Interaction Testing

**Navigate to Create Test page:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Create Test navigation tab",
  "ref": "nav-create"
}
```

**Fill in test name field:**
```
Tool: playwright-mcp-server-browser_type
Parameters: {
  "element": "Test name input field",
  "ref": "input[name='testName']",
  "text": "MCP Debug Test",
  "slowly": false
}
```

**Select test type from dropdown:**
```
Tool: playwright-mcp-server-browser_select_option
Parameters: {
  "element": "Test type dropdown",
  "ref": "select[name='testType']",
  "values": ["Tensile Test"]
}
```

**Submit the form:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Create Test button",
  "ref": "button[type='submit']"
}
```

### 4. Serial Port Interface Testing

**Navigate to Connect page:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Connect Device tab",
  "ref": "nav-connect"
}
```

**Check available serial ports:**
```
Tool: playwright-mcp-server-browser_evaluate
Parameters: {
  "function": "() => { const select = document.querySelector('select[name=\"serialPort\"]'); return select ? Array.from(select.options).map(opt => opt.value) : []; }"
}
```

**Select a serial port:**
```
Tool: playwright-mcp-server-browser_select_option
Parameters: {
  "element": "Serial port dropdown",
  "ref": "select[name='serialPort']",
  "values": ["COM3"]
}
```

**Click connect button:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Connect to device button",
  "ref": "button[data-action='connect']"
}
```

### 5. Configuration Testing

**Navigate to Device Configuration:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Device Configuration tab",
  "ref": "nav-configuration"
}
```

**Modify configuration values:**
```
Tool: playwright-mcp-server-browser_type
Parameters: {
  "element": "Max Force input field",
  "ref": "input[name='maxForce']",
  "text": "1000",
  "slowly": false
}
```

**Save configuration:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Save Configuration button",
  "ref": "button[data-action='save-config']"
}
```

### 6. Error State Testing

**Test form validation by submitting empty form:**
```
Tool: playwright-mcp-server-browser_click
Parameters: {
  "element": "Submit button with empty form",
  "ref": "button[type='submit']"
}
```

**Check for validation errors:**
```
Tool: playwright-mcp-server-browser_evaluate
Parameters: {
  "function": "() => { const errors = document.querySelectorAll('.error, .validation-error, [role=\"alert\"]'); return Array.from(errors).map(el => ({ text: el.textContent, class: el.className })); }"
}
```

### 7. Responsive Design Testing

**Resize window to mobile view:**
```
Tool: playwright-mcp-server-browser_resize
Parameters: {
  "width": 375,
  "height": 667
}
```

**Take mobile screenshot:**
```
Tool: playwright-mcp-server-browser_take_screenshot
Parameters: {
  "filename": "mobile-view.png"
}
```

**Resize to desktop:**
```
Tool: playwright-mcp-server-browser_resize
Parameters: {
  "width": 1920,
  "height": 1080
}
```

### 8. Console and Network Monitoring

**Get console messages after an action:**
```
Tool: playwright-mcp-server-browser_console_messages
Parameters: {}
```

**Monitor network requests:**
```
Tool: playwright-mcp-server-browser_network_requests
Parameters: {}
```

### 9. Keyboard Navigation Testing

**Test keyboard navigation:**
```
Tool: playwright-mcp-server-browser_press_key
Parameters: {
  "key": "Tab"
}
```

**Test keyboard shortcuts:**
```
Tool: playwright-mcp-server-browser_press_key
Parameters: {
  "key": "Control+S"
}
```

### 10. Data Persistence Testing

**Check if data persists after page reload:**
```
Tool: playwright-mcp-server-browser_evaluate
Parameters: {
  "function": "() => localStorage.getItem('testProfiles')"
}
```

**Navigate away and back to test state persistence:**
```
Tool: playwright-mcp-server-browser_navigate
Parameters: {
  "url": "file:///path/to/MaDControl/release/app/dist/index.html#/dashboard"
}
```

## Common Debugging Workflows

### Workflow A: Feature Development Validation

1. **Initial State Capture**
   - Take baseline screenshot
   - Capture DOM snapshot
   - Check console for existing errors

2. **Feature Testing** 
   - Navigate to feature area
   - Interact with new UI elements
   - Test form submissions/data entry

3. **Validation**
   - Verify expected behavior occurred
   - Check for JavaScript errors
   - Take final screenshot for comparison

### Workflow B: Bug Investigation

1. **Reproduce Bug**
   - Navigate to problem area
   - Perform steps that trigger the bug
   - Capture screenshot showing issue

2. **Investigate**
   - Check console messages for errors
   - Examine DOM state with evaluate
   - Monitor network requests for failures

3. **Document**
   - Save screenshots showing problem
   - Log error messages and stack traces
   - Note specific steps to reproduce

### Workflow C: UI/UX Validation

1. **Multi-Resolution Testing**
   - Test at different window sizes
   - Verify responsive behavior
   - Check mobile/tablet layouts

2. **Accessibility Testing**
   - Test keyboard navigation
   - Check focus indicators
   - Verify screen reader compatibility

3. **Visual Regression**
   - Compare screenshots before/after changes
   - Verify consistent styling
   - Check layout integrity

## Advanced MCP Techniques

### Custom Element Inspection
```
Tool: playwright-mcp-server-browser_evaluate
Parameters: {
  "function": "() => { return { components: Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid')), forms: document.forms.length, buttons: document.querySelectorAll('button').length }; }"
}
```

### Performance Monitoring
```
Tool: playwright-mcp-server-browser_evaluate  
Parameters: {
  "function": "() => { return { loadTime: performance.timing.loadEventEnd - performance.timing.navigationStart, domReady: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart }; }"
}
```

### Local Storage Inspection
```
Tool: playwright-mcp-server-browser_evaluate
Parameters: {
  "function": "() => { const storage = {}; for(let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); storage[key] = localStorage.getItem(key); } return storage; }"
}
```

This guide provides practical examples that can be directly used by Copilot agents to interact with and debug the MaD Control application using MCP Playwright tools.