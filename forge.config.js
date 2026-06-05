const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
  packagerConfig: {
    asar: true,
    name: 'GridTrack-Monitor',
    executableName: 'GridTrack-Monitor',
    icon: path.join(__dirname, 'assets', 'icon'),
    // Critical: Unpack all native modules and electron-store
    asarUnpack: [
      '**/node_modules/sharp/**',
      '**/node_modules/screenshot-desktop/**',
      '**/node_modules/bcrypt/**',
      '**/node_modules/electron-store/**',  // Added for persistence
      '**/node_modules/@img/**',            // Sharp dependencies
      '**/.env'
    ],
    // Ensure all dependencies are included
    prune: true,
    ignore: [
      /^\/\.git/,
      /^\/\.vscode/,
      /^\/backend\/node_modules/,
      /\.map$/,
      /\.md$/,
      /^\/test/,
      /^\/docs/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: process.platform === 'win32' ? ['win32'] : [], // Only build on Windows
      config: {
        name: 'gridtrack_monitor',
        setupExe: 'GridTrack-Monitor-Setup.exe',
        setupIcon: path.join(__dirname, 'assets', 'icon.ico'),
        authors: 'GridTrack',
        description: 'Employee Activity Monitoring System',
        version: '1.0.0'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
      config: {}
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {}
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {}
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    })
  ]
};