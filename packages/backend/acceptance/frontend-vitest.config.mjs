// Runs the web app's DOM-free library tests with the backend's vitest (node env).
// DOM tests (jsdom + MSW or localStorage, e.g. admin-api, wallet-reload) run in the web app's own `npm test`.
export default {test:{include:["src/**/*.test.ts"],exclude:["src/lib/admin-api.test.ts","src/lib/eth-server-data.test.ts","src/store/wallet-reload.test.ts","src/pages/settings-mnemonic.test.ts","src/store/wallet-owner.test.ts","src/store/wallet-autolock.test.ts","src/lib/custody-pending.test.ts","src/lib/stellar-pending.test.ts","node_modules/**","e2e/**"],maxWorkers:2}};
