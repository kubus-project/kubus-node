/**
 * The Local API's public entry points.
 *
 * The routing itself moved to `dispatch.ts` when a second transport (a WebRTC
 * data channel) had to serve the same operations: two route tables would drift
 * into disagreeing about which scope a route needs, and the disagreement would
 * be invisible until someone exploited it. This module stays as the import
 * site everything already uses.
 */
export { handleLocalApi, isAllowedLocalApiPeer } from './httpAdapter.js';
export { dispatchLocalRequest, routeScope, type LocalApiDeps } from './dispatch.js';
