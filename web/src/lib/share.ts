export { linkKind, readShare, type Shared } from '../../../src/shared/links';
export { platform, type Platform } from '../../../src/shared/platform';

/** Running as an installed web app (from the home screen), rather than in a browser tab. */
export const installed = () => window.matchMedia?.('(display-mode: standalone)').matches === true;
