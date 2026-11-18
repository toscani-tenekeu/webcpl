// Operating systems a VPS can be created from. All come from the images: remote of Incus.
export interface VpsImage {
  id: string
  name: string
  version: string
  alias: string
}

export const VPS_IMAGES: VpsImage[] = [
  { id: 'ubuntu-24.04', name: 'Ubuntu', version: '24.04 LTS', alias: 'ubuntu/24.04' },
  { id: 'ubuntu-22.04', name: 'Ubuntu', version: '22.04 LTS', alias: 'ubuntu/22.04' },
  { id: 'debian-13', name: 'Debian', version: '13', alias: 'debian/13' },
  { id: 'debian-12', name: 'Debian', version: '12', alias: 'debian/12' },
  { id: 'alma-9', name: 'AlmaLinux', version: '9', alias: 'almalinux/9' },
  { id: 'rocky-9', name: 'Rocky Linux', version: '9', alias: 'rockylinux/9' },
  { id: 'centos-9', name: 'CentOS Stream', version: '9', alias: 'centos/9-Stream' },
  { id: 'fedora-43', name: 'Fedora', version: '43', alias: 'fedora/43' },
  { id: 'alpine-3.22', name: 'Alpine', version: '3.22', alias: 'alpine/3.22' },
  { id: 'arch', name: 'Arch Linux', version: 'Rolling', alias: 'archlinux' },
  { id: 'opensuse-tumbleweed', name: 'openSUSE', version: 'Tumbleweed', alias: 'opensuse/tumbleweed' },
]

export const vpsImage = (id: unknown) => VPS_IMAGES.find((i) => i.id === id) ?? null

/** Names are the hostname inside the VPS too. */
export const VPS_NAME = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/
