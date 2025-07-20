/**
 * MCP Helper Utilities for MaD Control Debugging
 * 
 * This file provides common MCP tool usage patterns for Copilot agents
 * to simplify debugging and testing the MaD Control Electron application.
 */

/**
 * Common MCP Tool Usage Patterns
 * 
 * Copy and use these patterns with the MCP Playwright tools:
 */

const MCPHelpers = {
  
  // Navigation patterns
  navigation: {
    dashboard: {
      tool: "playwright-mcp-server-browser_click",
      params: {
        element: "Dashboard navigation tab",
        ref: "a[href*='dashboard'], [data-testid='nav-dashboard']"
      }
    },
    tests: {
      tool: "playwright-mcp-server-browser_click", 
      params: {
        element: "Tests navigation tab",
        ref: "a[href*='tests'], [data-testid='nav-tests']"
      }
    },
    create: {
      tool: "playwright-mcp-server-browser_click",
      params: {
        element: "Create Test navigation tab", 
        ref: "a[href*='create'], [data-testid='nav-create']"
      }
    },
    connect: {
      tool: "playwright-mcp-server-browser_click",
      params: {
        element: "Connect Device navigation tab",
        ref: "a[href*='connect'], [data-testid='nav-connect']"
      }
    },
    configuration: {
      tool: "playwright-mcp-server-browser_click",
      params: {
        element: "Device Configuration navigation tab",
        ref: "a[href*='configuration'], [data-testid='nav-configuration']"
      }
    }
  },

  // Screenshot patterns
  screenshots: {
    initial: {
      tool: "playwright-mcp-server-browser_take_screenshot",
      params: {
        filename: "debug-initial-state.png",
        raw: false
      }
    },
    afterAction: (actionName) => ({
      tool: "playwright-mcp-server-browser_take_screenshot", 
      params: {
        filename: `debug-after-${actionName}.png`,
        raw: false
      }
    }),
    mobile: {
      tool: "playwright-mcp-server-browser_take_screenshot",
      params: {
        filename: "debug-mobile-view.png",
        raw: false
      }
    },
    desktop: {
      tool: "playwright-mcp-server-browser_take_screenshot",
      params: {
        filename: "debug-desktop-view.png", 
        raw: false
      }
    }
  },

  // Form interaction patterns
  forms: {
    createTest: {
      name: {
        tool: "playwright-mcp-server-browser_type",
        params: {
          element: "Test name input field",
          ref: "input[name='testName'], input[placeholder*='name']",
          text: "MCP Debug Test"
        }
      },
      type: {
        tool: "playwright-mcp-server-browser_select_option",
        params: {
          element: "Test type dropdown",
          ref: "select[name='testType'], select[id*='testType']",
          values: ["Tensile Test"]
        }
      },
      submit: {
        tool: "playwright-mcp-server-browser_click",
        params: {
          element: "Create Test submit button",
          ref: "button[type='submit'], button[data-action='create']"
        }
      }
    },
    serialConnection: {
      selectPort: (port = "COM3") => ({
        tool: "playwright-mcp-server-browser_select_option",
        params: {
          element: "Serial port dropdown",
          ref: "select[name='serialPort'], select[id*='port']", 
          values: [port]
        }
      }),
      connect: {
        tool: "playwright-mcp-server-browser_click",
        params: {
          element: "Connect to device button",
          ref: "button[data-action='connect'], button[id*='connect']"
        }
      }
    }
  },

  // Debugging utilities
  debug: {
    domSnapshot: {
      tool: "playwright-mcp-server-browser_snapshot",
      params: {}
    },
    consoleMessages: {
      tool: "playwright-mcp-server-browser_console_messages", 
      params: {}
    },
    networkRequests: {
      tool: "playwright-mcp-server-browser_network_requests",
      params: {}
    },
    getAllElements: {
      tool: "playwright-mcp-server-browser_evaluate",
      params: {
        function: "() => { return { totalElements: document.querySelectorAll('*').length, forms: document.forms.length, buttons: document.querySelectorAll('button').length, inputs: document.querySelectorAll('input').length, selects: document.querySelectorAll('select').length, testIds: Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid')) }; }"
      }
    },
    getFormData: {
      tool: "playwright-mcp-server-browser_evaluate", 
      params: {
        function: "() => { const forms = Array.from(document.forms); return forms.map(form => ({ id: form.id, name: form.name, fields: Array.from(form.elements).map(el => ({ name: el.name, type: el.type, value: el.value })) })); }"
      }
    },
    getLocalStorage: {
      tool: "playwright-mcp-server-browser_evaluate",
      params: {
        function: "() => { const storage = {}; for(let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); storage[key] = localStorage.getItem(key); } return storage; }"
      }
    }
  },

  // Responsive design testing
  responsive: {
    mobile: {
      tool: "playwright-mcp-server-browser_resize",
      params: { width: 375, height: 667 }
    },
    tablet: {
      tool: "playwright-mcp-server-browser_resize", 
      params: { width: 768, height: 1024 }
    },
    desktop: {
      tool: "playwright-mcp-server-browser_resize",
      params: { width: 1920, height: 1080 }
    },
    smallDesktop: {
      tool: "playwright-mcp-server-browser_resize",
      params: { width: 1366, height: 768 }
    }
  },

  // Error checking patterns
  errorChecking: {
    validationErrors: {
      tool: "playwright-mcp-server-browser_evaluate",
      params: {
        function: "() => { const errors = document.querySelectorAll('.error, .validation-error, [role=\"alert\"], .MuiFormHelperText-root.Mui-error'); return Array.from(errors).map(el => ({ text: el.textContent.trim(), class: el.className, visible: el.offsetParent !== null })).filter(err => err.visible && err.text); }"
      }
    },
    consoleErrors: {
      tool: "playwright-mcp-server-browser_evaluate",
      params: {
        function: "() => { const errors = []; const originalError = console.error; console.error = function(...args) { errors.push(args.join(' ')); originalError.apply(console, args); }; return errors; }"
      }
    }
  }
};

/**
 * Usage Examples:
 * 
 * 1. Take initial screenshot:
 *    Use: MCPHelpers.screenshots.initial
 * 
 * 2. Navigate to dashboard:
 *    Use: MCPHelpers.navigation.dashboard
 * 
 * 3. Fill create test form:
 *    Use: MCPHelpers.forms.createTest.name
 *    Then: MCPHelpers.forms.createTest.type  
 *    Then: MCPHelpers.forms.createTest.submit
 * 
 * 4. Check for errors:
 *    Use: MCPHelpers.errorChecking.validationErrors
 * 
 * 5. Test mobile view:
 *    Use: MCPHelpers.responsive.mobile
 *    Then: MCPHelpers.screenshots.mobile
 * 
 * 6. Debug DOM structure:
 *    Use: MCPHelpers.debug.getAllElements
 */

// Export for potential use in Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MCPHelpers;
}

// Also make available globally for browser console usage
if (typeof window !== 'undefined') {
  window.MCPHelpers = MCPHelpers;
}