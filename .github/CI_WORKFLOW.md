# CI/CD Workflow Architecture

## Overview

The MaD project uses a unified CI workflow with job dependencies for robust testing and deployment. This follows the industry standard pattern used by major projects like React, Vue, and Angular.

## Workflow Structure

### Main CI Workflow (`ci.yml`)

The primary workflow handles all build and test operations with explicit job dependencies:

```
┌─────────────┐
│   changes   │ ← Detects which components changed
└─────┬───────┘
      │
    ┌─▼─────────────────────────────────────┐
    │                                       │
┌───▼──────────┐                  ┌────▼───────────┐
│build-software│                  │ build-firmware │
│(Software/**)  │                  │ (Firmware/**)  │
└───┬──────────┘                  └────┬───────────┘
    │                                  │
    └─────────────┐      ┌─────────────┘
                  │      │
               ┌──▼──────▼──┐
               │ sil-tests  │ ← Runs only when both builds succeed
               └────────────┘
```

### Job Dependencies

- **`changes`**: Uses `dorny/paths-filter` to detect which areas changed
- **`build-software`**: Runs only when `Software/**` files change
- **`build-firmware`**: Runs only when `Firmware/**` files change  
- **`sil-tests`**: Depends on both builds, runs only when both areas have changes and builds succeed
- **Release jobs**: Handle tag-based releases independently

### Benefits

✅ **Immediate visibility**: All jobs show up as checks in PRs immediately  
✅ **Required checks**: Easy to set SIL tests as required in branch protection  
✅ **No timing issues**: Explicit dependencies ensure proper execution order  
✅ **Resource efficient**: Jobs only run when relevant files change  
✅ **Robust**: Eliminates race conditions and artifact synchronization issues  

### Legacy Workflows

- `software-build.yml`: Handles only tagged software releases
- `firmware-build.yml`: Handles only tagged firmware releases

## Setting Up Required Checks

To make SIL tests a required check in GitHub:

1. Go to repository Settings → Branches
2. Add branch protection rule for `main`
3. Enable "Require status checks to pass before merging"
4. Search for and add: `CI / sil-tests`

The SIL tests will now appear as a required check that waits for the build jobs to complete successfully.