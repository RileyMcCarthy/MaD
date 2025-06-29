import { BrowserWindow } from 'electron';
import { Notification, NotificationType } from '@shared/SharedInterface';
import { uiLogger } from '@utils/logger';

class NotificationSender {
  private window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  sendNotification(notification: Notification) {
    uiLogger.info(`Notification (${notification.Type}):`, notification.Message);

    switch (notification.Type) {
      case NotificationType.ERROR:
        this.sendError(notification.Message);
        break;
      case NotificationType.WARN:
        this.sendWarning(notification.Message);
        break;
      case NotificationType.INFO:
        this.sendInfo(notification.Message);
        break;
      case NotificationType.SUCCESS:
        this.sendSuccess(notification.Message);
        break;
      default:
        this.sendInfo(notification.Message);
    }
  }

  sendError(notification: string) {
    uiLogger.error('Error:', notification);
    this.window.webContents.send('notification-error', notification);
  }

  sendWarning(notification: string) {
    uiLogger.warn('Warning:', notification);
    this.window.webContents.send('notification-warning', notification);
  }

  sendInfo(notification: string) {
    uiLogger.info('Info:', notification);
    this.window.webContents.send('notification-info', notification);
  }

  sendSuccess(notification: string) {
    uiLogger.info('Success:', notification);
    this.window.webContents.send('notification-success', notification);
  }
}

export default NotificationSender;
