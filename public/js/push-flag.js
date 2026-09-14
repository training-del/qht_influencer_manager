/* Whether this build may register for push notifications.
 *
 * false here, on the website. scripts/build-apk.mjs writes over this file
 * inside the APK — true only when the build includes Firebase
 * (android/app/google-services.json). Without Firebase, asking the native
 * plugin to register crashes the app on start, so nothing else may ask. */
export const PUSH_READY = false;
