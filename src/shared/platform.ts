// Shared by the server's tests and the web app: where the web app is running.

export type Platform = 'app' | 'ios' | 'android' | 'other';

/** Our iPhone app (its web view adds BJJNotesApp/… to the user agent), Safari on iOS, Android, or elsewhere. */
export function platform(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): Platform {
  if (/BJJNotesApp\//.test(ua)) return 'app';
  // iPads ask for desktop sites, so they say "Macintosh"; a touch screen gives them away.
  const touchMac = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}
