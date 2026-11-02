/**
 * The release-order rule, checked before MaD Control is released: some
 * published firmware release must speak the app's protocol, or every machine
 * the new app connects to would be refused as incompatible with nothing to
 * update to. After a protocol_version bump, release the firmware first.
 *
 *   MAD_APP_PROTOCOL=3 [GITHUB_TOKEN=…] [MAD_FIRMWARE_REPO=owner/name] vite-node tools/check-firmware-protocol.mts
 *
 * Software/Control/scripts/release.sh runs this from --check (CI, on a
 * madcontrol-v* tag) and --publish (before tagging), passing the protocol
 * version of the commit being released.
 */
import { releasedProtocols } from './firmwareRelease';

/** The verdict as a line to print, and whether the release may go ahead. */
export function firmwareForProtocol(
  released: { tag: string; protocolVersion: number }[],
  protocol: number,
): { ok: boolean; message: string } {
  const match = released.find((r) => r.protocolVersion === protocol);
  if (match) return { ok: true, message: `firmware ${match.tag} speaks protocol ${protocol}` };
  const others = released.map((r) => `${r.tag} (protocol ${r.protocolVersion})`).join(', ') || 'none';
  return {
    ok: false,
    message:
      `no published firmware release speaks protocol ${protocol} (newest per protocol: ${others}). ` +
      'Release the firmware first (git tag firmware-vX.Y.Z), then MaD Control.',
  };
}

async function main(): Promise<void> {
  const protocol = Number(process.env.MAD_APP_PROTOCOL);
  if (!Number.isInteger(protocol)) throw new Error('set MAD_APP_PROTOCOL to the protocol version being released');
  const verdict = firmwareForProtocol(await releasedProtocols(fetch, process.env), protocol);
  if (!verdict.ok) throw new Error(verdict.message);
  console.log(verdict.message);
}

// Like assemble-pages-app.mts: run unless a test imported it (vitest sets VITEST).
if (!process.env.VITEST) {
  main().catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
