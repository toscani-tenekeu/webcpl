import { ref } from 'vue'
import { api } from '@/lib/api'
import type { Account } from '@/lib/types'

interface Me {
  user: Account | null
  impersonator: { id: number; username: string; role: string } | null
  panelName: string
  version: string
}

export const user = ref<Account | null>(null)
/** Set while an admin or reseller is signed in as this account. */
export const impersonator = ref<Me['impersonator']>(null)
export const panelName = ref('Webcpl')
export const version = ref('')
export const ready = ref(false)

export function applySession(me: Me) {
  user.value = me.user
  impersonator.value = me.impersonator
  panelName.value = me.panelName || 'Webcpl'
  version.value = me.version
  ready.value = true
  document.title = panelName.value
}

export async function refreshSession() {
  const me = await api<Me>('/api/auth/me').catch(() => ({ user: null, impersonator: null, panelName: 'Webcpl', version: '' }))
  applySession(me)
  return me.user
}
