import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BrowserWindow } from 'electron';

/**
 * Configuration for GitHub artifact download
 */
export interface DownloadConfig {
  /** GitHub owner/repo path or full URL */
  repoUrl: string;
  /** Name or pattern of the artifact to download */
  artifactName?: string;
  /** Extension filter for artifacts */
  artifactExtension?: string;
  /** Output directory */
  outputDir: string;
  /** Optional BrowserWindow to send progress messages */
  window?: BrowserWindow;
  /** Optional event name for progress updates */
  progressEvent?: string;
  /** Optional event name for error updates */
  errorEvent?: string;
}

/**
 * Result of download operation
 */
export interface DownloadResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

/**
 * Send a progress message to the UI via window webContents
 */
function sendProgressMessage(window: BrowserWindow | undefined, event: string | undefined, message: string): void {
  if (window && event) {
    window.webContents.send(event, message);
  }
}

/**
 * Send an error message to the UI via window webContents
 */
function sendErrorMessage(window: BrowserWindow | undefined, event: string | undefined, message: string): void {
  if (window && event) {
    window.webContents.send(event, message);
  }
}

/**
 * Parse GitHub repository URL
 * @param repoUrl Full GitHub URL or owner/repo string
 * @returns Cleaned owner/repo string
 */
export function parseGitHubRepo(repoUrl: string): string {
  if (repoUrl.includes('github.com')) {
    // Extract owner/repo from URL
    const url = new URL(repoUrl);
    const pathParts = url.pathname.split('/').filter(part => part.length > 0);
    if (pathParts.length >= 2) {
      return `${pathParts[0]}/${pathParts[1]}`;
    }
    throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  }

  // Assume it's already in owner/repo format
  if (repoUrl.split('/').length === 2) {
    return repoUrl;
  }

  throw new Error(`Invalid GitHub repository format: ${repoUrl}`);
}

/**
 * Get latest release information from GitHub
 * @param repoPath Repository path in format 'owner/repo'
 * @returns Promise with release data
 */
export async function getLatestRelease(repoPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repoPath}/releases/latest`,
      headers: {
        'User-Agent': 'MaDJS-App',
      },
    };

    https.get(options, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirects
        if (response.headers.location) {
          https.get(response.headers.location, handleResponse).on('error', reject);
        } else {
          reject(new Error(`Redirect received but no location header found`));
        }
        return;
      }

      handleResponse(response);

      function handleResponse(res: any) {
        if (res.statusCode !== 200) {
          // Handle rate limiting specifically
          if (res.statusCode === 403) {
            const rateLimitRemaining = res.headers['x-ratelimit-remaining'];
            const rateLimitReset = res.headers['x-ratelimit-reset'];

            if (rateLimitRemaining === '0') {
              // We're rate limited
              const resetTime = rateLimitReset ? new Date(parseInt(rateLimitReset, 10) * 1000) : 'unknown time';
              reject(new Error(`GitHub API rate limit exceeded. Limit will reset at ${resetTime}. Try again later or use a direct download URL.`));
            } else {
              // Some other 403 error
              reject(new Error(`GitHub API request forbidden (403). This could be due to rate limiting or access restrictions.`));
            }
            return;
          }

          // Handle other status codes
          reject(new Error(`GitHub API request failed with status code: ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });

        res.on('end', () => {
          try {
            const releaseData = JSON.parse(data);
            resolve(releaseData);
          } catch (error) {
            reject(new Error(`Failed to parse GitHub API response: ${error}`));
          }
        });
      }
    }).on('error', reject);
  });
}

/**
 * Download a file from a URL to a specific path
 * @param url URL to download from
 * @param outputPath Path to save the file
 * @param window Optional BrowserWindow to send progress messages
 * @param progressEvent Optional event name for progress updates
 * @returns Promise resolving to the path of the downloaded file
 */
export async function downloadFile(
  url: string,
  outputPath: string,
  window?: BrowserWindow,
  progressEvent?: string,
  errorEvent?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Create the directory if it doesn't exist
    const dirPath = path.dirname(outputPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    sendProgressMessage(window, progressEvent, `Downloading from: ${url}`);
    const file = fs.createWriteStream(outputPath);

    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirects
        if (response.headers.location) {
          file.close();
          downloadFile(response.headers.location, outputPath, window, progressEvent, errorEvent)
            .then(resolve)
            .catch(reject);
          return;
        } else {
          reject(new Error(`Redirect received but no location header found`));
          return;
        }
      }

      if (response.statusCode !== 200) {
        sendErrorMessage(window, errorEvent, `Failed to download, status code: ${response.statusCode}`);
        reject(new Error(`Failed to download, status code: ${response.statusCode}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      let lastProgressPercent = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          // Only report progress when it changes by at least 5%
          if (percent >= lastProgressPercent + 5) {
            lastProgressPercent = percent;
            sendProgressMessage(window, progressEvent, `Downloading: ${percent}% (${downloadedBytes} / ${totalBytes} bytes)`);
          }
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        sendProgressMessage(window, progressEvent, `Download complete: ${outputPath}`);
        resolve(outputPath);
      });

      response.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        sendErrorMessage(window, errorEvent, `Download error: ${err.message}`);
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      sendErrorMessage(window, errorEvent, `Connection error: ${err.message}`);
      reject(err);
    });

    file.on('error', (err) => {
      fs.unlink(outputPath, () => {});
      sendErrorMessage(window, errorEvent, `File error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Download an artifact from the latest GitHub release
 * @param config Download configuration
 * @returns Promise with download result
 */
export async function downloadLatestArtifact(config: DownloadConfig): Promise<DownloadResult> {
  try {
    const {
      repoUrl,
      artifactName,
      artifactExtension,
      outputDir,
      window,
      progressEvent = 'download-progress',
      errorEvent = 'download-error'
    } = config;

    // Parse the repository URL to get the owner/repo format
    const repoPath = parseGitHubRepo(repoUrl);

    sendProgressMessage(window, progressEvent, `Fetching latest release for ${repoPath}...`);

    // Get latest release info
    const releaseData = await getLatestRelease(repoPath);

    if (!releaseData || !releaseData.assets || releaseData.assets.length === 0) {
      const error = 'No assets found in the latest release';
      sendErrorMessage(window, errorEvent, error);
      return { success: false, error };
    }

    sendProgressMessage(window, progressEvent, `Found release: ${releaseData.tag_name || 'latest'}`);

    // Find the appropriate asset
    let asset = null;

    // Log all available assets for debugging
    if (window) {
      sendProgressMessage(window, progressEvent, `Available assets: ${releaseData.assets.map((a: any) => a.name).join(', ')}`);
    }

    if (artifactName) {
      // Look for specific artifact
      asset = releaseData.assets.find((a: any) => a.name === artifactName);
    } else if (artifactExtension) {
      // Look for asset with specific extension
      asset = releaseData.assets.find((a: any) => a.name.endsWith(artifactExtension));
    }

    // If not found, use the first asset
    if (!asset && releaseData.assets.length > 0) {
      asset = releaseData.assets[0];
    }

    if (!asset) {
      const error = 'No matching artifact found in the latest release';
      sendErrorMessage(window, errorEvent, error);
      return { success: false, error };
    }

    sendProgressMessage(window, progressEvent, `Selected artifact: ${asset.name}`);

    // Download the asset
    const outputPath = path.join(outputDir, asset.name);
    await downloadFile(asset.browser_download_url, outputPath, window, progressEvent, errorEvent);

    // Make the file executable if on Unix and it's a binary
    if (os.platform() !== 'win32' &&
        (asset.name.endsWith('.sh') ||
         !asset.name.includes('.') ||
         asset.name.endsWith('.mac') ||
         asset.name.endsWith('.rpi'))) {
      fs.chmodSync(outputPath, '755');
      sendProgressMessage(window, progressEvent, `Made ${asset.name} executable`);
    }

    return {
      success: true,
      filePath: outputPath
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendErrorMessage(config.window, config.errorEvent, `Download failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Download a specific artifact from GitHub releases
 * @param repoUrl The GitHub repository URL or owner/repo string
 * @param artifactName The name of the artifact to download
 * @param outputDir Directory to save the downloaded file
 * @param window Optional BrowserWindow for progress messages
 * @param progressEvent Optional event name for progress updates
 * @param errorEvent Optional event name for error updates
 * @returns Promise with download result
 */
export async function downloadGitHubArtifact(
  repoUrl: string,
  artifactName: string,
  outputDir: string,
  window?: BrowserWindow,
  progressEvent: string = 'download-progress',
  errorEvent: string = 'download-error'
): Promise<DownloadResult> {
  try {
    // Create the output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Configure and execute the download
    return await downloadLatestArtifact({
      repoUrl,
      artifactName,
      outputDir,
      window,
      progressEvent,
      errorEvent
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (window) {
      window.webContents.send(errorEvent, `Failed to download artifact: ${errorMessage}`);
    }
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Get platform-specific binary name
 * @returns The appropriate binary name for the current platform
 */
export function getPlatformBinaryName(baseName: string): string {
  const platform = os.platform();
  const isArm = process.arch === 'arm' || process.arch.includes('arm');

  if (platform === 'win32') {
    return `${baseName}.exe`;
  } else if (platform === 'darwin') {
    return `${baseName}.mac`;
  } else if (platform === 'linux' && isArm) {
    return `${baseName}.rpi`;
  } else {
    return baseName;
  }
}

/**
 * Get the latest firmware version from GitHub
 * @param repoPath GitHub repository path (e.g. 'RileyMcCarthy/MaD-Firmware')
 * @returns Promise with the version string
 */
export async function getLatestFirmwareVersion(repoPath: string): Promise<string> {
  try {
    const releaseData = await getLatestRelease(repoPath);

    // The tag_name typically contains the version (e.g., "v1.0.0")
    const version = releaseData.tag_name?.replace(/^v/, '') || 'Unknown'; // Remove 'v' prefix if present
    console.log(`Latest firmware version from GitHub: ${version}`);
    return version;
  } catch (error) {
    console.error('Error fetching latest firmware version:', error);
    return 'Unknown';
  }
}
