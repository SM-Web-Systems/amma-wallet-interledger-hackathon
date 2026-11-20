// Metro resolves Node core modules (stream, crypto, ...) used by the Stellar
// HD-wallet stack (bip39 -> create-hash -> cipher-base) to the React Native
// shims in node-libs-react-native. Without this the app bundle fails to build.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.extraNodeModules = {
  ...require("node-libs-react-native"),
  ...config.resolver.extraNodeModules,
};

module.exports = config;
