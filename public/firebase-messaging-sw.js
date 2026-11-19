/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyB8dA1ZW13UtbdmeUGahFjRJkht7RXu1Lc',
  authDomain: 'attendence-system-867c1.firebaseapp.com',
  databaseURL: 'https://attendence-system-867c1-default-rtdb.firebaseio.com',
  projectId: 'attendence-system-867c1',
  storageBucket: 'attendence-system-867c1.firebasestorage.app',
  messagingSenderId: '1067385874361',
  appId: '1:1067385874361:web:da3ffbe331505b6a7e7868',
  measurementId: 'G-BCM285Q750',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'SmartAttend';
  const options = {
    body: payload?.notification?.body || 'You have a new attendance notification.',
  };
  self.registration.showNotification(title, options);
});
