# Playwright Testing Setup for MaD Control

This document describes how to use Playwright testing with the MaD Control Electron application, specifically designed for integration with GitHub Copilot coding agents.

## Overview

The MaD Control application now includes comprehensive Playwright-based end-to-end testing that covers:

- **UI Interactions**: Navigation, form filling, button clicks, and user interface testing
- **Serial Communication**: Mocked serial port interactions for hardware simulation
- **File Operations**: Test profile management, data storage, and configuration persistence
- **Integration Testing**: Complete workflow testing from connection to data export

## Quick Start

### Installation

Playwright and its dependencies are already installed with the project:

```bash
cd Software/MaDControl
npm install
```

### Running Tests

```bash
# Build the application first (required for Electron testing)
npm run build

# Run all e2e tests in headless mode
npm run test:e2e

# Run tests with visible browser (useful for debugging)
npm run test:e2e:headed

# Run tests with step-by-step debugging
npm run test:e2e:debug

# Run tests with Playwright UI (interactive test runner)
npm run test:e2e:ui
```

## Test Structure

### Core Test Files

- `tests/e2e/ui.spec.ts` - UI interaction and navigation tests
- `tests/e2e/serial.spec.ts` - Serial communication testing with mocks
- `tests/e2e/fileOps.spec.ts` - File storage and retrieval functionality
- `tests/e2e/integration.spec.ts` - Comprehensive end-to-end workflow tests

### Helper Modules

- `tests/e2e/helpers/electron.ts` - Electron application launcher and page fixtures
- `tests/e2e/helpers/serialMock.ts` - Serial port communication mocking utilities
- `tests/e2e/helpers/fileOperations.ts` - File system operation testing helpers

## Key Features for Copilot Agents

### 1. Autonomous Test Execution

All tests are designed to run without human intervention:

```typescript
// Tests automatically launch the Electron app
const { electronApp, page } = test.fixtures;

// Navigate and interact with UI elements
await page.click('text=Connect');
await page.waitForLoadState('networkidle');
```

### 2. Serial Port Simulation

Hardware interactions are fully mocked:

```typescript
// Simulate device connection
await serialMocker.simulateConnection();

// Mock complete test sequences
await serialMocker.simulateTensileTest();

// Handle error scenarios
await serialMocker.simulateError();
```

### 3. File System Testing

File operations are tested without requiring actual files:

```typescript
// Test profile saving
await fileHelper.testSaveTestProfile();

// Verify data persistence
const profiles = await fileHelper.testLoadTestProfiles();
expect(profiles).toContain(expectedProfile);
```

### 4. Comprehensive Workflow Testing

The integration test demonstrates a complete user workflow:

1. Application launch
2. Device connection
3. Test profile creation
4. Machine configuration
5. Test execution
6. Data visualization
7. Result storage
8. Error handling and recovery

## Using with GitHub Copilot

### Copilot Agent Commands

The Copilot coding agent can run these tests using:

```bash
# For CI/CD integration
npm run test:e2e

# For development and debugging
npm run test:e2e:headed
```

### Test Development with Copilot

When adding new features, Copilot agents can:

1. **Generate new test scenarios** based on application changes
2. **Update mock data** for different hardware configurations  
3. **Extend file operation tests** for new data formats
4. **Create regression tests** for bug fixes

Example Copilot prompt:
> "Add a test for the new calibration feature in MaD Control. The test should navigate to the calibration page, simulate calibration data, and verify the results are saved correctly."

### Debugging Failed Tests

When tests fail, the Copilot agent can:

1. **Review test output** and screenshots in the `test-results/` directory
2. **Run individual test files** to isolate issues:
   ```bash
   npx playwright test tests/e2e/ui.spec.ts --headed
   ```
3. **Use debug mode** to step through failing tests:
   ```bash
   npx playwright test tests/e2e/integration.spec.ts --debug
   ```

## Mock Data Customization

### Serial Port Responses

Customize mock responses in `serialMock.ts`:

```typescript
export const mockSerialResponses = {
  // Add custom responses for your hardware
  customCommand: 'CUSTOM:RESPONSE',
  sensorCalibration: (value: number) => `CAL:${value}`,
};
```

### Test Data

Modify sample data in `fileOperations.ts`:

```typescript
private sampleTestProfile = {
  name: 'Your Test Profile',
  parameters: {
    // Customize for your test requirements
    maxForce: 20,
    testSpeed: 75,
  },
};
```

## Configuration

### Playwright Configuration

The `playwright.config.ts` file is optimized for Electron testing:

- Tests run in parallel for faster execution
- HTML reports generated for CI/CD
- Traces captured on test failures
- Configured for Electron app launching

### Environment Variables

Set these environment variables for different test modes:

- `CI=true` - Enables CI-specific settings (retries, single worker)
- `HEADED=true` - Forces headed mode even in CI
- `DEBUG=true` - Enables verbose logging

## Continuous Integration

### GitHub Actions Integration

Add this to your `.github/workflows/test.yml`:

```yaml
- name: Run E2E Tests
  run: |
    cd Software/MaDControl
    npm run build
    npm run test:e2e
    
- name: Upload Test Results
  uses: actions/upload-artifact@v3
  if: failure()
  with:
    name: playwright-report
    path: Software/MaDControl/playwright-report/
```

### Test Reports

- HTML reports: `playwright-report/index.html`
- Screenshots: `test-results/`
- Traces: Available in the HTML report for failed tests

## Troubleshooting

### Common Issues

1. **Electron app fails to launch**
   - Ensure `npm run build` was run first
   - Check that all dependencies are installed

2. **Tests timeout**
   - Increase timeout in test files: `test.setTimeout(60000)`
   - Check that the app is actually loading properly

3. **Mock data not working**
   - Verify the electron API is properly exposed
   - Check console output for mock injection errors

### Getting Help

For Copilot agents encountering issues:

1. Run tests with verbose output: `npm run test:e2e -- --reporter=list`
2. Check the generated HTML report for detailed failure information
3. Use headed mode to visually inspect test execution
4. Review the mock data and ensure it matches expected application behavior

## Best Practices

### For Copilot Agents

1. **Always build before testing**: Run `npm run build` before `npm run test:e2e`
2. **Use appropriate test modes**: Headless for CI, headed for debugging
3. **Check test reports**: Review HTML reports for detailed failure analysis
4. **Update mocks when adding features**: Ensure mock data reflects new application capabilities
5. **Test incrementally**: Run individual test files when developing new features

### Test Maintenance

1. **Keep mocks synchronized** with actual hardware behavior
2. **Update test data** when file formats change
3. **Add regression tests** for all bug fixes
4. **Review and update timeouts** as application complexity grows

## Examples for Common Tasks

### Adding a New Page Test

```typescript
test('should handle new feature page', async ({ page }) => {
  await page.click('text=New Feature');
  await page.waitForLoadState('networkidle');
  
  // Test specific functionality
  const featureButton = page.locator('[data-testid="feature-button"]');
  await featureButton.click();
  
  // Verify results
  await expect(page.locator('.feature-result')).toBeVisible();
});
```

### Testing New Serial Commands

```typescript
// Add to serialMock.ts
newCommand: (param: string) => `NEW_CMD:${param}`,

// Use in test
await serialMocker.setupMockResponses([
  mockSerialResponses.newCommand('test_value')
]);
```

### Testing File Operations

```typescript
test('should handle new file format', async ({ page }) => {
  const newData = { format: 'v2', data: [...] };
  
  await fileHelper.testSaveCustomData(newData);
  const loaded = await fileHelper.testLoadCustomData();
  
  expect(loaded.format).toBe('v2');
});
```

This testing setup enables comprehensive automated testing of the MaD Control application, allowing Copilot coding agents to validate functionality across UI interactions, hardware communication, and data persistence without requiring manual intervention or physical hardware.