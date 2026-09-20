/* asyncWebAssembly is required by the crypto WASM module loaded during client init */
const nextConfig = {
  webpack: (config) => {
    config.experiments = { ...(config.experiments || {}), asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;