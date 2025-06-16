import { BrowserWindow, ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { getLatestRelease } from '../utils/GithubDownloader';

/**
 * Class that handles firmware version checking and cleanup
 */
export default class FirmwareUpdater {
  /** The electron window instance */
  private window: BrowserWindow;

  /** Path to temporary directory */
  private tempDir: string;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.tempDir = path.join(app.getPath('temp'), 'mad-firmware-update');
    this.setupHandlers();
  }

  /**
   * Set up IPC handlers for firmware-related operations
   */
  private setupHandlers(): void {
    // Handler for getting the latest firmware version from GitHub
    ipcMain.handle('get-latest-firmware-version', async () => {
      try {
        const latestVersion = await this.fetchLatestFirmwareVersion();
        return latestVersion;
      } catch (error) {
        console.error('Error getting latest firmware version:', error);
        return null;
      }
    });
  }

  /**
   * Fetch the latest firmware version from GitHub
   */
  public async fetchLatestFirmwareVersion(
    owner: string = 'RileyMcCarthy',
    repo: string = 'MaD-Firmware',
  ): Promise<string> {
    try {
      const repoPath = `${owner}/${repo}`;
      this.window.webContents.send(
        'firmware-update-progress',
        `Checking version from ${repoPath}...`,
      );

      const releaseData = await getLatestRelease(repoPath);

      // The tag_name typically contains the version (e.g., "v1.0.0")
      const version = releaseData.tag_name?.replace(/^v/, '') || 'Unknown'; // Remove 'v' prefix if present
      console.log(`Latest firmware version from GitHub: ${version}`);
      return version;
    } catch (error) {
      console.error('Error fetching latest firmware version:', error);
      throw error;
    }
  }

  /**
   * Clean up temporary files
   */
  public cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        console.log('Cleaned up temporary firmware files');
      }
    } catch (err) {
      console.error('Error cleaning up temporary files:', err);
    }
  }
}
