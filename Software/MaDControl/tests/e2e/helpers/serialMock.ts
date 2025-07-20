/**
 * Serial Port Mock Helper
 * 
 * This helper provides utilities for mocking serial port communication
 * during Playwright testing. It includes common serial port responses
 * and utilities for simulating different device states.
 */

// Mock serial port responses for testing
export const mockSerialResponses = {
  // Machine status responses
  machineReady: 'STATUS:READY',
  machineConnected: 'CONN:OK',
  machineFault: 'STATUS:FAULT',
  machineMoving: 'STATUS:MOVING',
  
  // Position and sensor data
  positionData: (position: number) => `POS:${position}`,
  forceData: (force: number) => `FORCE:${force}`,
  
  // Configuration responses
  configResponse: 'CONFIG:OK',
  parameterSet: (param: string, value: string) => `SET:${param}:${value}`,
  
  // Error responses
  invalidCommand: 'ERROR:INVALID_COMMAND',
  communicationError: 'ERROR:COMM_FAIL',
  hardwareFault: 'ERROR:HARDWARE_FAULT',
};

// Mock data sequences for testing different scenarios
export const mockDataSequences = {
  // Normal tensile test sequence
  tensileTest: [
    mockSerialResponses.machineReady,
    mockSerialResponses.positionData(0),
    mockSerialResponses.forceData(0),
    mockSerialResponses.machineMoving,
    mockSerialResponses.positionData(5),
    mockSerialResponses.forceData(1.2),
    mockSerialResponses.positionData(10),
    mockSerialResponses.forceData(2.5),
    mockSerialResponses.positionData(15),
    mockSerialResponses.forceData(3.8),
    mockSerialResponses.machineReady,
  ],
  
  // Error scenario
  errorSequence: [
    mockSerialResponses.machineReady,
    mockSerialResponses.hardwareFault,
    mockSerialResponses.machineFault,
  ],
};

// Helper to inject serial port mocks into the Electron app
export class SerialPortMocker {
  private responses: string[] = [];
  private currentIndex = 0;

  constructor(private page: any) {}

  // Set up mock responses for the next serial commands
  async setupMockResponses(responses: string[]) {
    this.responses = responses;
    this.currentIndex = 0;
    
    // Inject mock into the renderer process
    await this.page.evaluate((mockResponses) => {
      // Override the serial port communication if it exists
      if (window.electronAPI && window.electronAPI.serial) {
        const originalSend = window.electronAPI.serial.send;
        let responseIndex = 0;
        
        window.electronAPI.serial.send = async (data: string) => {
          // Simulate response delay
          await new Promise(resolve => setTimeout(resolve, 50));
          
          // Return mock response
          if (responseIndex < mockResponses.length) {
            const response = mockResponses[responseIndex++];
            // Trigger the response callback if it exists
            if (window.electronAPI.serial.onData) {
              window.electronAPI.serial.onData(response);
            }
            return response;
          }
          return 'NO_RESPONSE';
        };
      }
    }, this.responses);
  }

  // Simulate a device connection
  async simulateConnection() {
    await this.setupMockResponses([
      mockSerialResponses.machineConnected,
      mockSerialResponses.machineReady,
    ]);
  }

  // Simulate a complete test sequence
  async simulateTensileTest() {
    await this.setupMockResponses(mockDataSequences.tensileTest);
  }

  // Simulate error conditions
  async simulateError() {
    await this.setupMockResponses(mockDataSequences.errorSequence);
  }
}