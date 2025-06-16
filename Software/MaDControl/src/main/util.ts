/* eslint import/prefer-default-export: off */
import { URL } from 'url';
import path from 'path';
import { dialog, BrowserWindow } from 'electron';

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}

/**
 * Shows a file open dialog to select a firmware file
 * @param window The parent browser window
 * @returns Promise that resolves to selected file path or undefined if canceled
 */
export async function showFirmwareFileDialog(
  window: BrowserWindow,
): Promise<string | undefined> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Select Firmware File',
    properties: ['openFile'],
    filters: [
      { name: 'Firmware Files', extensions: ['bin'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (canceled || filePaths.length === 0) {
    return undefined;
  }

  return filePaths[0];
}
