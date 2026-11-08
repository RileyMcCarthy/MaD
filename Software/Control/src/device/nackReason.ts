/**
 * Why the device refused a request, in words.
 *
 * The fourth byte of every NACK frame is a reason code from the protocol's
 * table (ProtoEmb's own codes below 0x20, MaD's from `nack_reasons` in
 * MaDProtocol.yaml). The generated codec carries the table; this turns a code
 * into something a log line or an error message can say.
 */

import { NACK_REASON_INFO } from '@/protocol/generated/protoemb';

/** The reason's name (`BAD_SIZE`), or `reason 0x55` for a code this app does not know. */
export function nackReasonName(reason: number | undefined): string {
  if (reason === undefined) return 'no reason given';
  return NACK_REASON_INFO[reason]?.name ?? `reason 0x${reason.toString(16).padStart(2, '0')}`;
}

/** Name and meaning (`BAD_SIZE: The payload is not the size this command takes.`). */
export function nackReasonText(reason: number | undefined): string {
  const info = reason === undefined ? undefined : NACK_REASON_INFO[reason];
  return info ? `${info.name}: ${info.description}` : nackReasonName(reason);
}
