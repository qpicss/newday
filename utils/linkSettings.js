// The console's gateway link: an mTLS listener gateways call to register, pull configuration,
// send heartbeats, report usage and check admin UI sign-ins.
//   GATEWAY_LINK_ENABLED     false to turn it off (default on)
//   GATEWAY_LINK_PORT        default 3443
//   GATEWAY_LINK_HOST        default 0.0.0.0
//   GATEWAY_LINK_PUBLIC_URL  address gateways use, e.g. https://console.example.com:3443
const linkSettings = () => {
  const port = Number(process.env.GATEWAY_LINK_PORT) || 3443;
  let publicUrl = process.env.GATEWAY_LINK_PUBLIC_URL;
  if (!publicUrl) {
    let host = 'localhost';
    try {
      if (process.env.APP_URL) host = new URL(process.env.APP_URL).hostname;
    } catch {
      // keep localhost
    }
    publicUrl = `https://${host}:${port}`;
  }
  return {
    enabled: process.env.GATEWAY_LINK_ENABLED !== 'false',
    port,
    host: process.env.GATEWAY_LINK_HOST || '0.0.0.0',
    publicUrl: publicUrl.replace(/\/+$/, ''),
  };
};

module.exports = { linkSettings };
