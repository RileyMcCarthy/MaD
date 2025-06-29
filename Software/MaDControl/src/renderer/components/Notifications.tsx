import { useEffect } from 'react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { componentLogger } from '../utils/logger';

function NotificationComponent() {
  const setError = (message: string) => {
    componentLogger.error('Error notification:', message);
    toast.error(message, {
      position: 'top-right',
    });
  };

  const setWarning = (message: string) => {
    componentLogger.warn('Warning notification:', message);
    toast.warn(message, {
      position: 'top-right',
    });
  };

  const setInfo = (message: string) => {
    componentLogger.info('Info notification:', message);
    toast.info(message, {
      position: 'top-right',
    });
  };

  const setSuccess = (message: string) => {
    componentLogger.info('Success notification:', message);
    toast.success(message, {
      position: 'top-right',
    });
  };

  useEffect(() => {
    const handleError = (...args: unknown[]) => {
      const message = args[0] as string;
      setError(message);
    };

    const handleWarning = (...args: unknown[]) => {
      const message = args[0] as string;
      setWarning(message);
    };

    const handleInfo = (...args: unknown[]) => {
      const message = args[0] as string;
      setInfo(message);
    };

    const handleSuccess = (...args: unknown[]) => {
      const message = args[0] as string;
      setSuccess(message);
    };

    const unsubscribeError = window.electron.ipcRenderer.on(
      'notification-error',
      handleError,
    );
    const unsubscribeWarning = window.electron.ipcRenderer.on(
      'notification-warning',
      handleWarning,
    );
    const unsubscribeInfo = window.electron.ipcRenderer.on(
      'notification-info',
      handleInfo,
    );
    const unsubscribeSuccess = window.electron.ipcRenderer.on(
      'notification-success',
      handleSuccess,
    );

    return () => {
      unsubscribeError();
      unsubscribeWarning();
      unsubscribeInfo();
      unsubscribeSuccess();
    };
  }, []);

  return (
    <ToastContainer
      position="top-right"
      autoClose={5000}
      hideProgressBar={false}
      newestOnTop
      closeOnClick
      rtl={false}
      draggable
      pauseOnHover
      theme="dark"
    />
  );
}

export default NotificationComponent;
