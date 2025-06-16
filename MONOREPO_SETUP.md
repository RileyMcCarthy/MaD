# MaD Mono-Repo Workflow Setup

This document explains how the mono-repository is configured to handle separate builds and releases for Firmware, Hardware, Software, and Documentation components.

## 🏗️ Repository Structure

```
MaD/
├── .github/
│   └── workflows/
│       ├── firmware-build.yml
│       ├── software-build.yml
│       ├── hardware-build.yml
│       └── docs-build.yml
├── Firmware/
│   └── MaDCore/
├── Hardware/
│   ├── PowerBoard/
│   ├── EdgeBoard/
│   └── DS2Addon/
├── Software/
│   └── MaDControl/
└── Docs/
```

## 🚀 How It Works

### Path-Based Triggers
Each workflow only runs when files in its respective directory are changed:
- **Firmware**: Triggers on changes to `Firmware/**`
- **Software**: Triggers on changes to `Software/**` 
- **Hardware**: Triggers on changes to `Hardware/**`
- **Docs**: Triggers on changes to `Docs/**`

### Separate Release Systems
Each component has its own independent versioning and release system using prefixed tags:

## 📦 Creating Releases

### Firmware Releases
```bash
# Create a firmware release
git tag firmware-v1.0.0
git push origin firmware-v1.0.0
```
- **Tag format**: `firmware-v{version}`
- **Release name**: "MaD Firmware v{version}"
- **Artifacts**: Compiled firmware binary (`program`)

### Software Releases
```bash
# Create a software release
git tag software-v1.0.0
git push origin software-v1.0.0
```
- **Tag format**: `software-v{version}`
- **Release name**: "MaD Software v{version}"
- **Artifacts**: 
  - macOS builds (x64, arm64)
  - Windows builds (x64)
  - Raspberry Pi builds (armv7l, arm64)

### Hardware Releases
```bash
# Create a hardware release
git tag hardware-v1.0.0
git push origin hardware-v1.0.0
```
- **Tag format**: `hardware-v{version}`
- **Release name**: "MaD Hardware v{version}"
- **Artifacts** (for each board):
  - Gerber files (zipped)
  - Schematic PDFs
  - Bill of Materials (CSV)
  - Drill files

### Documentation Releases
```bash
# Create a documentation release
git tag docs-v1.0.0
git push origin docs-v1.0.0
```
- **Tag format**: `docs-v{version}`
- **Release name**: "MaD Documentation v{version}"
- **Artifacts**: Compiled documentation archive

## 🔧 Workflow Details

### Firmware Workflow (`firmware-build.yml`)
- **Platform**: Ubuntu (PlatformIO)
- **Triggers**: Push/PR to main with `Firmware/**` changes, or `firmware-v*` tags
- **Build Process**:
  1. Install PlatformIO
  2. Install Propeller platform
  3. Build with version embedding
  4. Package binary for release

### Software Workflow (`software-build.yml`)  
- **Platforms**: macOS, Windows, Ubuntu (for Raspberry Pi)
- **Triggers**: Push/PR to main with `Software/**` changes, or `software-v*` tags
- **Build Process**:
  1. Setup Python 3.10 + Node.js 20
  2. Install dependencies in `Software/MaDControl/`
  3. Build and package Electron app
  4. Cross-compile for Raspberry Pi architectures

### Hardware Workflow (`hardware-build.yml`)
- **Platform**: Ubuntu (KiCad CLI)
- **Triggers**: Push/PR to main with `Hardware/**` changes, or `hardware-v*` tags  
- **Build Process**:
  1. Install KiCad 7.0
  2. For each project (PowerBoard, EdgeBoard, DS2Addon):
     - Generate Gerber files
     - Create drill files  
     - Export schematics to PDF
     - Generate BOM (if possible)
     - Package everything for release

### Documentation Workflow (`docs-build.yml`)
- **Platform**: Ubuntu
- **Triggers**: Push/PR to main with `Docs/**` changes, or `docs-v*` tags
- **Build Process**:
  1. Auto-detect documentation type (Node.js, Sphinx, Jekyll, Markdown, Static)
  2. Build accordingly
  3. Package for release

## 🎯 Usage Examples

### Development Workflow
```bash
# Work on firmware
cd Firmware/MaDCore
# Make changes...
git add .
git commit -m "Fix sensor calibration"
git push
# ✅ Only firmware workflow runs

# Work on software  
cd Software/MaDControl
# Make changes...
git add .
git commit -m "Add new UI feature"
git push  
# ✅ Only software workflow runs
```

### Release Workflow
```bash
# Release all components with coordinated versions
git tag firmware-v2.1.0
git tag software-v2.1.0  
git tag hardware-v2.1.0
git tag docs-v2.1.0

git push origin firmware-v2.1.0
git push origin software-v2.1.0
git push origin hardware-v2.1.0  
git push origin docs-v2.1.0

# Or release components independently
git tag firmware-v2.1.1  # Hotfix for firmware only
git push origin firmware-v2.1.1
```

## 🔍 Monitoring Builds

- **Actions Tab**: View all workflow runs
- **Artifacts**: Download build artifacts from completed runs
- **Releases**: Find all releases organized by component
- **Status Badges**: Add to README for build status visibility

## 🛠️ Customization

### Adding New Components
1. Create new directory (e.g., `Mobile/`)
2. Add new workflow file (e.g., `.github/workflows/mobile-build.yml`)
3. Use path trigger: `paths: ['Mobile/**']`
4. Use tag format: `mobile-v*`

### Modifying Build Steps
Each workflow can be customized independently:
- Update Node.js/Python versions
- Add new build targets
- Modify artifact packaging
- Change release naming

## 🚨 Troubleshooting

### Workflow Not Triggering
- Check that changes are in the correct path (`Firmware/**`, `Software/**`, etc.)
- Verify branch name matches trigger (`main`)
- Ensure you're pushing commits, not just local changes

### Build Failures
- Check workflow logs in Actions tab
- Verify all dependencies are correctly specified
- Ensure working directory paths are correct

### Release Issues  
- Confirm tag format matches exactly (`component-v1.0.0`)
- Verify `GITHUB_TOKEN` permissions
- Check that artifacts were generated successfully

## 💡 Best Practices

1. **Consistent Versioning**: Use semantic versioning (e.g., `v1.2.3`)
2. **Coordinated Releases**: Tag all components together for major releases
3. **Independent Updates**: Use separate tags for component-specific updates
4. **Clear Commit Messages**: Help identify which workflows should trigger
5. **Test Before Release**: Use PR builds to verify before creating release tags 