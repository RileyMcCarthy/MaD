import { BrowserWindow } from 'electron';
import { Notification, NotificationType } from '../../shared/SharedInterface';

class NotificationSender {
  private window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  sendNotification(notification: Notification) {
    console.log(`Notification (${notification.Type}):`, notification.Message);

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
    console.log('Error:', notification);
    this.window.webContents.send('notification-error', notification);
  }

  sendWarning(notification: string) {
    console.log('Warning:', notification);
    this.window.webContents.send('notification-warning', notification);
  }

  sendInfo(notification: string) {
    console.log('Info:', notification);
    this.window.webContents.send('notification-info', notification);
  }

  sendSuccess(notification: string) {
    console.log('Success:', notification);
    this.window.webContents.send('notification-success', notification);
  }
}

export default NotificationSender;
