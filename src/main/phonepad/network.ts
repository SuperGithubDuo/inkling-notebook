/**
 * Which address should the phone use to reach this computer?
 *
 * Computers often have several: Wi-Fi, Ethernet, and virtual adapters from
 * VPNs, Docker, WSL/Hyper-V or virtual machines that a phone can never reach.
 * Only private IPv4 addresses are offered (never a public one), ranked so the
 * likely home/office network comes first. Pure, so it is unit-tested.
 */
import type { NetworkInterfaceInfo } from 'node:os'
import type { PhonePadAddress } from '@shared/phonepad'
import { isPrivateAddress } from '@shared/phonepad'

/** Adapter names that are virtual or tunnels on Windows, macOS and Linux. */
const VIRTUAL = /(docker|veth|br-|virbr|vmnet|vbox|virtualbox|vethernet|hyper-?v|wsl|utun|tun|tap|ppp|ipsec|zt|zerotier|tailscale|wg|wireguard|nordlynx|awdl|llw|bridge|anpi|loopback|vpn)/i
const WIRELESS = /(wi-?fi|wlan|wireless|wl[a-z0-9]|airport)/i

export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): PhonePadAddress[] {
  const found: { address: PhonePadAddress; rank: number }[] = []
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4' || !isPrivateAddress(info.address)) continue
      // Self-assigned (169.254.x.x) means no network was joined.
      if (info.address.startsWith('169.254.')) continue
      let rank = 0
      if (VIRTUAL.test(name)) rank += 100
      if (info.address.startsWith('192.168.')) rank -= 3
      else if (info.address.startsWith('10.')) rank -= 2
      else rank -= 1 // 172.16–31.x: common for Docker/WSL, rarely home Wi-Fi
      if (WIRELESS.test(name)) rank -= 5
      // macOS: en0 is almost always the built-in Wi-Fi or primary port.
      if (name === 'en0') rank -= 4
      found.push({ address: { host: info.address, label: friendlyName(name) }, rank })
    }
  }
  found.sort((a, b) => a.rank - b.rank)
  const seen = new Set<string>()
  return found.filter(({ address }) => !seen.has(address.host) && seen.add(address.host)).map((f) => f.address)
}

function friendlyName(name: string): string {
  if (WIRELESS.test(name) || name === 'en0') return 'Wi-Fi'
  if (/^(eth|en|ethernet)/i.test(name)) return 'Ethernet'
  return name.slice(0, 40)
}
