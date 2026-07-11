/** @type {import('next').NextConfig} */
const nextConfig = {
  // The worker (worker/) and shared lib (lib/) are plain TS run by tsx; Next only
  // builds the app/. Nothing in app/ imports the server-only worker, so the
  // service-role DB client never reaches the browser bundle.
};
export default nextConfig;
