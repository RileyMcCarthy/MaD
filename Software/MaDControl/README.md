# MaD Control

Control software for the MaD Tensile Testing Machine.

## Installation

### macOS Users - Important Security Notice

If you downloaded this app from GitHub Actions artifacts, macOS may block it from running because it's not code signed. Here's how to fix this:

#### Method 1: Remove Quarantine (Recommended)
1. Open Terminal
2. Navigate to where you downloaded the app
3. Run: `xattr -dr com.apple.quarantine "MaD Control.app"`
4. The app should now run normally

#### Method 2: System Preferences
1. Try to open the app (it will be blocked)
2. Go to System Preferences > Security & Privacy > General
3. Click "Allow Anyway" next to the blocked app message
4. Try opening the app again and click "Open"

#### Method 3: Right-click Method
1. Right-click on the app
2. Select "Open" from the context menu
3. Click "Open" in the security dialog

### Development

```bash
# Install dependencies
npm install

# Start development server
npm start

# Build for production
npm run package
```

## Features

- Serial communication with MaD hardware
- Real-time data visualization
- Sample profile management
- Firmware update capabilities

## License

MIT