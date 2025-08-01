# CI/CD Workflow Architecture

## Overview

The MaD project uses a unified CI workflow for testing with separate release workflows for independent component releases. This provides comprehensive SIL testing while maintaining flexible release management.

## Workflow Structure

### Main CI Workflow (`ci.yml`)

The primary workflow handles builds and SIL testing for pull requests and pushes:

```
┌─────────────┐
│   changes   │ ← Detects which components changed
└─────┬───────┘
      │
    ┌─▼─────────────────────────────────────┐
    │     When either component changes     │
┌───▼──────────┐                  ┌────▼───────────┐
│build-software│                  │ build-firmware │
│   (always)   │                  │   (always)     │
└───┬──────────┘                  └────┬───────────┘
    │                                  │
    └─────────────┐      ┌─────────────┘
                  │      │
               ┌──▼──────▼──┐
               │ sil-tests  │ ← Runs when either component changes
               └────────────┘
```

### Separate Release Workflows

- **`software-build.yml`**: Triggered only by `software-v*` tags
- **`firmware-build.yml`**: Triggered only by `firmware-v*` tags  
- **`hardware-build.yml`**: Triggered by `hardware-v*` tags

### Key Logic Changes

- **Both builds always run**: When either Software/ or Firmware/ changes, both components are built
- **SIL tests run for any change**: Tests run when either component changes (not just both)
- **Independent releases**: CI workflow only handles testing; releases are handled by separate workflows

### Benefits

✅ **Comprehensive testing**: SIL tests validate integration when either component changes  
✅ **Independent releases**: Each component can be released separately without affecting others  
✅ **No release conflicts**: CI workflow never interferes with release processes  
✅ **Immediate visibility**: All jobs show up as checks in PRs immediately  
✅ **Required checks**: Easy to set SIL tests as required in branch protection  

## Release Strategy

Each component maintains independent release cycles:

- **Software releases**: Create `software-v1.2.3` tags to trigger software-only releases
- **Firmware releases**: Create `firmware-v1.2.3` tags to trigger firmware-only releases  
- **Hardware releases**: Create `hardware-v1.2.3` tags to trigger hardware-only releases

The CI workflow never interferes with these releases and only handles testing.

## Setting Up Required Checks

To make SIL tests a required check in GitHub:

1. Go to repository Settings → Branches
2. Add branch protection rule for `main`
3. Enable "Require status checks to pass before merging"
4. Search for and add: `CI / sil-tests`

The SIL tests will now appear as a required check that waits for the build jobs to complete successfully.