importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAynuPWAbwu6etjBTqBejpppw4S4umoKPM",
  authDomain: "my-tracker-d4776.firebaseapp.com",
  databaseURL: "https://my-tracker-d4776-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "my-tracker-d4776",
  storageBucket: "my-tracker-d4776.firebasestorage.app",
  messagingSenderId: "207196018290",
  appId: "1:207196018290:web:e544ccd2eac3e84150d4eb"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "Reminder";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body: body,
    icon: "https://www.gstatic.com/firebasejs/9.0.0/firebase.svg"
  });
});
