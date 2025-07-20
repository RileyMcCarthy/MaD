# Quick Reference: MCP Playwright Tools for New PRs

## For Copilot Agents Working on MaD Control

When working on new features or bug fixes, use these MCP Playwright tools to debug and validate changes in real-time.

## Essential MCP Tools

### 🌐 Navigation
- `playwright-mcp-server-browser_navigate` - Navigate to app pages
- `playwright-mcp-server-browser_snapshot` - Get DOM structure and accessibility tree
- `playwright-mcp-server-browser_take_screenshot` - Capture visual state

### 🖱️ Interaction  
- `playwright-mcp-server-browser_click` - Click buttons, tabs, links
- `playwright-mcp-server-browser_type` - Fill form inputs
- `playwright-mcp-server-browser_select_option` - Select dropdown options

### 🔍 Debugging
- `playwright-mcp-server-browser_evaluate` - Run JavaScript and inspect data
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