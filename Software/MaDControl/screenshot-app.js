/**
 * Simple script to take screenshots of the MaD Control app
 * Usage: node screenshot-app.js
 * 
 * This script builds and packages the Electron app, then takes screenshots for debugging purposes.
 * It uses xvfb to run in headless environments.
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 Building MaD Control app...');
try {
  execSync('npm run build', { 
    stdio: 'inherit', 
    cwd: __dirname 
  });
  console.log('✅ Build completed successfully');
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}

console.log('📦 Packaging app for testing...');
try {
  execSync('npm run package', { 
    stdio: 'inherit', 
    cwd: __dirname 
  });
  console.log('✅ Packaging completed successfully');
} catch (error) {
  console.error('❌ Packaging failed:', error.message);
  process.exit(1);
}

console.log('📸 Taking screenshots with Playwright...');
try {
  execSync('npm run test:e2e', { 
    stdio: 'inherit', 
    cwd: __dirname 
  });
  console.log('✅ Screenshots taken successfully');
  console.log('📁 Screenshots saved as:');
  console.log('   - proof-main-interface.png');
  console.log('   - proof-final-state.png');
} catch (error) {
  console.error('❌ Screenshot failed:', error.message);
  process.exit(1);
}

console.log('🎉 Done! Check the PNG files in the current directory.');