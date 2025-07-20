# MCP Playwright Tools - Practical Usage Guide for MaD Control

This guide provides real-world examples of using Playwright MCP tools to debug, test, and validate the MaD Control Electron application during development.

## Prerequisites

1. Build the application first:
```bash
cd Software/MaDControl
npm run build
```

2. Launch the app in development mode:
```bash
npm run dev:mcp
```

## MCP Tool Usage Examples

### 1. Initial App Inspection

**Navigate to the application:**
```
Tool: playwright-mcp-server-browser_navigate
Parameters: {
  "url": "file:///path/to/MaDControl/release/app/dist/index.html"
}
```

**Take an initial screenshot:**
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