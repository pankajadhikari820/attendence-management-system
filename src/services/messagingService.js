import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { app } from '../firebase/config.js';
import { showToast } from '../utils/ui.js';

let messagingInstance = null;

export async function initForegroundMessaging() {
  try {
    const supported = await isSupported();
    if (!supported) return { supported: false, reason: 'Browser does not support Web Push API.' };
    messagingInstance = getMessaging(app);
    onMessage(messagingInstance, (payload) => {
      const title = payload?.notification?.title || 'SmartAttend Alert';
      const body = payload?.notification?.body || '';
      showToast(`${title}${body ? ': ' + body : ''}`, 'info', 6000);
    });
    return { supported: true };
  } catch (err) {
    return { supported: false, reason: err.message };
  }
}

export async function registerPushToken(vapidKey) {
  if (!vapidKey || !vapidKey.trim()) {
    throw new Error('A Firebase Web Push VAPID key is required to register device push notifications.');
  }
  const supported = await isSupported();
  if (!supported) {
    throw new Error('Push notifications are not supported in this browser context.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Browser notification permission was denied.');
  }
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  if (!messagingInstance) messagingInstance = getMessaging(app);
  const token = await getToken(messagingInstance, {
    vapidKey: vapidKey.trim(),
    serviceWorkerRegistration: reg,
  });
  return token;
}
