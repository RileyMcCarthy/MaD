const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');

module.exports = async function configureFuses(context) {
  console.log('Configuring Electron fuses for CI testing compatibility...');

  const { electronPlatformName, appOutDir } = context;
  
  try {
    // Determine the correct executable path based on platform
    let executablePath;
    if (electronPlatformName === 'win32') {
      executablePath = path.join(appOutDir, 'MaD Control.exe');
    } else if (electronPlatformName === 'darwin') {
      executablePath = path.join(appOutDir, 'MaD Control.app', 'Contents', 'MacOS', 'MaD Control');
    } else {
      executablePath = path.join(appOutDir, 'mad-control'); // Linux executable name
    }
    
    console.log(`Configuring fuses for: ${executablePath}`);
    
    // Configure fuses to ensure proper CLI inspect support
    await flipFuses(executablePath, {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
      [FuseV1Options.EnableNodeCliInspectArguments]: true,
    });
    
    console.log('✓ Electron fuses configured successfully');
  } catch (error) {
    console.warn('⚠️  Failed to configure fuses:', error.message);
    // Don't fail the build if fuses can't be configured in development
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
  }
};
