// webcpl <command>: administration on the server itself.
import { generatePassword, hashPasswordSync } from './auth.ts'
import { ensureAdmin } from './bootstrap.ts'
import { config, version } from './config.ts'
import { db, logActivity } from './db.ts'

const [command] = process.argv.slice(2)

switch (command) {
  case 'reset-admin-password': {
    ensureAdmin()
    const password = generatePassword(20)
    db.query("UPDATE users SET password_hash = ?, totp_enabled = 0, totp_secret = NULL WHERE username = 'admin'").run(hashPasswordSync(password))
    db.query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'admin')").run()
    logActivity({ action: 'reset the administrator password from the server' })
    console.log(`New password for "admin": ${password}\nTwo-factor sign-in was turned off for this account.`)
    break
  }
  case 'info':
    console.log(`Webcpl ${version}\nport: ${config.port}\ndata: ${config.dataDir}\nagent: ${config.agentSocket}`)
    break
  default:
    console.log('Usage: webcpl <command>\n\n  reset-admin-password   new random password for "admin" (turns off its two-factor sign-in)\n  info                   version and paths')
    process.exitCode = command ? 1 : 0
}
process.exit()
