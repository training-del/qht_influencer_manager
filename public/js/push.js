/**
 * Notifications in the Android app.
 *
 * After sign-in, influencers and head influencers are asked once for permission;
 * the app's Firebase token is then saved on the server, which is what the
 * scheduled Worker sends to (worker/src/cron.js). Signing out removes it
 * (see auth.logout). Tapping a notification opens the screen it is about.
 *
 * Does nothing on the website, for the admin, or in an APK built without
 * Firebase — see push-flag.js.
 */
import { api, PUSH_KEY } from '/js/api.js';
import { PUSH_READY } from '/js/push-flag.js';

const ROLES = ['influencer', 'head_influencer'];

/**
 * @param {object} me                         /auth/me result
 * @param {(screen: string) => void} [onOpen] a notification was tapped
 * @returns {Promise<string>} what happened, for tests and logs
 */
export async function enablePush(me, onOpen) {
  const Push = window.Capacitor?.Plugins?.PushNotifications;
  if (!PUSH_READY || !Push) return 'unavailable';
  if (!ROLES.includes(me?.user?.role)) return 'not-for-role';

  try {
    await Push.removeAllListeners();

    Push.addListener('registration', async ({ value }) => {
      if (!value) return;
      try {
        await api('/devices', { method: 'POST', body: { token: value, platform: 'android' } });
        localStorage.setItem(PUSH_KEY, value);
      } catch { /* tried again the next time the app opens */ }
    });
    Push.addListener('registrationError', e => console.warn('push registration failed', e?.error));
    Push.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const screen = notification?.data?.screen;
      if (screen) onOpen?.(screen);
    });

    let perm = await Push.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await Push.requestPermissions();
    }
    if (perm.receive !== 'granted') return 'denied';

    // Android shows notifications per channel; this is the one the server names
    await Push.createChannel({
      id: 'reminders', name: 'Reminders',
      description: 'The daily photo reminder and photos waiting for review',
      importance: 4, visibility: 1
    }).catch(() => {});

    await Push.register();
    return 'registered';
  } catch (err) {
    console.warn('push notifications unavailable', err);
    return 'error';
  }
}
