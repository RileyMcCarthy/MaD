# Unified CI Architecture

The MaD project now uses a single, comprehensive CI workflow that handles all building, testing, and releasing for software, firmware, and hardware components.

## Workflow Structure

### Single CI Workflow (`ci.yml`)

**Triggers:**
- **Push/PR**: Any changes to `Software/`, `Firmware/`, or `Hardware/`
- **Release Tags**: `software-v*`, `firmware-v*`, `hardware-v*`

**Jobs:**

1. **changes** - Detects which components changed using `dorny/paths-filter`
2. **build-software** - Builds MaD Control (when software/firmware changes or software release)
3. **build-firmware** - Builds firmware (when software/firmware changes or firmware release)  
4. **build-hardware** - Builds hardware KiCad files (when hardware changes or hardware release)
5. **sil-tests** - Runs SIL integration tests (only for software/firmware changes, not releases)
6. **release-software** - Creates software releases (only for `software-v*` tags)
7. **release-firmware** - Creates firmware releases (only for `firmware-v*` tags)
8. **release-hardware** - Creates hardware releases (only for `hardware-v*` tags)

## Key Features

### Smart Component Detection
- Only builds components that have changed
- SIL tests run when either software OR firmware changes (ensuring integration testing)
- Hardware builds are independent and don't trigger SIL tests

### Fixed SIL Testing
- **Electron Installation**: Fixed Playwright test failures by using full `npm ci --legacy-peer-deps`
- **Proper Error Detection**: Captures actual test exit codes instead of ignoring failures
- **Artifact-Based**: Uses pre-built software and firmware artifacts for testing

### Independent Releases
- **Software Releases**: `software-v1.2.3` tags trigger software-only builds and releases
- **Firmware Releases**: `firmware-v1.2.3` tags trigger firmware-only builds and releases  
- **Hardware Releases**: `hardware-v1.2.3` tags trigger hardware-only builds and releases
- **No Cross-Contamination**: Each release type is completely independent

### Build Optimization
- **No Duplication**: Removed redundant native builds from separate workflows
- **Artifact Reuse**: SIL tests download pre-built artifacts instead of rebuilding
- **Conditional Execution**: Jobs only run when needed based on changes and trigger type

## Migration from Separate Workflows

The following workflows can now be **removed** as all functionality is handled by `ci.yml`:

- `software-build.yml` ❌ (replaced by ci.yml build-software + release-software)
- `firmware-build.yml` ❌ (replaced by ci.yml build-firmware + release-firmware)  
- `hardware-build.yml` ❌ (replaced by ci.yml build-hardware + release-hardware)

## Usage Examples

### Development Workflow
1. Make changes to `Software/` or `Firmware/`
2. Push or create PR
3. CI automatically builds both components and runs SIL tests
4. All integration testing ensures compatibility

### Release Workflow
1. **Software Release**: `git tag software-v1.2.3 && git push --tags`
2. **Firmware Release**: `git tag firmware-v1.2.3 && git push --tags`  
3. **Hardware Release**: `git tag hardware-v1.2.3 && git push --tags`
4. CI builds only the tagged component and creates GitHub release

### Hardware Development
1. Make changes to `Hardware/`
2. Push or create PR
3. CI builds hardware artifacts only (no SIL tests)
4. Manufacturing files generated automatically

## Benefits

✅ **Comprehensive Testing**: SIL tests run for any software/firmware change  
✅ **Independent Releases**: Each component can be released separately  
✅ **No Conflicts**: CI testing never interferes with release processes  
✅ **Better Performance**: Only builds what's needed  
✅ **Easier Maintenance**: Single workflow file instead of multiple  
✅ **Robust Error Handling**: Proper test failure detection and reporting