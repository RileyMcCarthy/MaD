import React, { useEffect } from 'react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

function NotificationComponent() {
  const setError = (message: string) => {
    console.log(message);
    toast.error(message, {
      position: 'top-right',
    });
  };

  const setWarning = (message: string) => {
    console.log(message);
    toast.warn(message, {
      position: 'top-right',
    });
  };

  const setInfo = (message: string) => {
    console.log(message);
    toast.info(message, {
      position: 'top-right',
    });
  };

  const setSuccess = (message: string) => {
    console.log(message);
    toast.success(message, {
      position: 'top-right',
    });
  };

  useEffect(() => {
    const unsubscribeError = window.electron.ipcRenderer.on('notification-error', setError);
    const unsubscribeWarning = window.electron.ipcRenderer.on('notification-warning', setWarning);
    const unsubscribeInfo = window.electron.ipcRenderer.on('notification-info', setInfo);
    const unsubscribeSuccess = window.electron.ipcRenderer.on('notification-success', setSuccess);

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