/**
 * The firmware's own "reboot to apply" message after a machine profile write.
 *
 * Firmware sends "Machine profile saved to SD Card, please reboot" as a
 * notification. The app turns it into a reboot prompt with a button rather
 * than a toast that only says what to do.
 */
export function isRebootNotice(message: string): boolean {
  return /saved to sd card.*reboot/i.test(message);
}
