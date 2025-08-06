const { FusesPlugin } = require('@electron/fuses');

async function configureFuses(context) {
  const { electronPlatformName, appOutDir } = context;
  
  console.log('Configuring Electron fuses for CI testing compatibility...');
  
  // Configure fuses to ensure proper CLI inspect support
  await FusesPlugin({
    version: FusesPlugin.FUSE_VERSION_V1,
    [FusesPlugin.FUSE_V1_OPTIONS.EnableNodeCliInspectArguments]: true,
    [FusesPlugin.FUSE_V1_OPTIONS.EnableNodeOptionsEnvironmentVariable]: true,
    [FusesPlugin.FUSE_V1_OPTIONS.RunAsNode]: false,
  }).afterPack(context);
}

module.exports = configureFuses;