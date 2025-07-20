/**
 * File Operations Helper
 * 
 * This helper provides utilities for testing file storage and retrieval
 * functionality in the MaD Control application.
 */

import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

export class FileOperationsHelper {
  constructor(private page: Page) {}

  // Test sample data structure
  private sampleTestProfile = {
    name: 'Test Profile 1',
    description: 'Automated test profile',
    parameters: {
      maxForce: 10,
      maxStrain: 100,
      testSpeed: 50,
      preload: 0.1,
    },
    created: new Date().toISOString(),
  };

  private sampleRunData = {
    profileName: 'Test Profile 1',
    timestamp: new Date().toISOString(),
    data: [
      { time: 0, position: 0, force: 0 },
      { time: 1, position: 5, force: 1.2 },
      { time: 2, position: 10, force: 2.5 },
      { time: 3, position: 15, force: 3.8 },
      { time: 4, position: 20, force: 4.1 },
    ],
    results: {
      maxForce: 4.1,
      maxStrain: 20,
      youngModulus: 0.205,
    },
  };

  // Create test files in the application data directory
  async createTestFiles() {
    await this.page.evaluate((testProfile, runData) => {
      // Create test profile file through electron API
      if (window.electronAPI && window.electronAPI.files) {
        window.electronAPI.files.saveTestProfile(testProfile);
        window.electronAPI.files.saveRunData(runData);
      }
    }, this.sampleTestProfile, this.sampleRunData);
  }

  // Test saving a new test profile
  async testSaveTestProfile() {
    await this.page.evaluate((profile) => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.saveTestProfile(profile);
      }
      return Promise.reject('File API not available');
    }, this.sampleTestProfile);
  }

  // Test loading test profiles
  async testLoadTestProfiles() {
    const profiles = await this.page.evaluate(() => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.loadTestProfiles();
      }
      return Promise.reject('File API not available');
    });
    return profiles;
  }

  // Test saving run data
  async testSaveRunData() {
    await this.page.evaluate((runData) => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.saveRunData(runData);
      }
      return Promise.reject('File API not available');
    }, this.sampleRunData);
  }

  // Test loading run data
  async testLoadRunData() {
    const runData = await this.page.evaluate(() => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.loadRunData();
      }
      return Promise.reject('File API not available');
    });
    return runData;
  }

  // Test configuration persistence
  async testSaveConfiguration() {
    const testConfig = {
      serialPort: '/dev/ttyUSB0',
      baudRate: 9600,
      machineSettings: {
        maxForce: 100,
        safetyLimits: {
          maxPosition: 500,
          maxSpeed: 200,
        },
      },
    };

    await this.page.evaluate((config) => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.saveConfiguration(config);
      }
      return Promise.reject('File API not available');
    }, testConfig);
  }

  // Test loading configuration
  async testLoadConfiguration() {
    const config = await this.page.evaluate(() => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.loadConfiguration();
      }
      return Promise.reject('File API not available');
    });
    return config;
  }

  // Cleanup test files
  async cleanupTestFiles() {
    await this.page.evaluate(() => {
      if (window.electronAPI && window.electronAPI.files) {
        return window.electronAPI.files.cleanupTestFiles();
      }
      return Promise.resolve();
    });
  }

  // Get sample data for testing
  getSampleTestProfile() {
    return { ...this.sampleTestProfile };
  }

  getSampleRunData() {
    return { ...this.sampleRunData };
  }
}